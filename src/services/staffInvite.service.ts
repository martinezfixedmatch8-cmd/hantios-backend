import type { staff_invites } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { generateSecureToken } from "../lib/tokens";
import { hashPassword, recordPasswordHistory } from "../lib/password";
import { writeAuditLog } from "../lib/auditLog";
import { conflict, gone, notFound } from "../lib/errors";
import { env, CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from "../lib/config";
import { getNotificationProvider } from "../notifications/registry";
import type { CreateInviteInput, AcceptInviteInput } from "../validation/staffInvite.schema";

interface Actor {
  userId: string;
  businessId: string;
}

export async function createStaffInvite(input: CreateInviteInput, actor: Actor) {
  const existingUser = await prisma.users.findUnique({ where: { email: input.email } });
  if (existingUser) {
    throw conflict("A user with this email already exists");
  }

  const pendingInvite = await prisma.staff_invites.findFirst({
    where: {
      business_id: actor.businessId,
      email: input.email,
      accepted_at: null,
      revoked_at: null,
      expires_at: { gt: new Date() },
    },
  });
  if (pendingInvite) {
    throw conflict("A pending invite already exists for this email");
  }

  const inviter = await prisma.users.findUniqueOrThrow({ where: { id: actor.userId } });

  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + env.STAFF_INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  const invite = await prisma.staff_invites.create({
    data: {
      id: generateId(),
      business_id: actor.businessId,
      email: input.email,
      full_name: input.fullName,
      phone: input.phone,
      role: input.role,
      token,
      invited_by: actor.userId,
      expires_at: expiresAt,
    },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: inviter.id,
    userName: inviter.name,
    userRole: inviter.role,
    action: "staff_invite.created",
    entityType: "staff_invite",
    entityId: invite.id,
    reason: `Staff invitation created for ${input.role} role`,
  });

  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  const acceptUrl = `${env.APP_BASE_URL}/invite/${token}`;
  await getNotificationProvider().send({
    category: "TRANSACTIONAL",
    channel: "email",
    to: input.email,
    subject: `You've been invited to join ${business.name} on HantiOS`,
    body: `${inviter.name} invited you to join ${business.name} as a ${input.role}. Accept your invitation: ${acceptUrl}`,
  });

  return toInviteDto(invite);
}

function toInviteDto(invite: staff_invites) {
  return {
    id: invite.id,
    fullName: invite.full_name,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expires_at,
    createdAt: invite.created_at,
  };
}

async function findInviteByTokenOrThrow(token: string) {
  const invite = await prisma.staff_invites.findUnique({
    where: { token },
    include: { businesses: true },
  });
  if (!invite) {
    throw notFound("Invite not found");
  }
  if (invite.revoked_at) {
    throw gone("This invitation has been revoked");
  }
  if (invite.expires_at < new Date()) {
    throw gone("This invitation has expired");
  }
  if (invite.accepted_at) {
    throw conflict("This invitation has already been accepted");
  }
  return invite;
}

export async function getInvitePreview(token: string) {
  const invite = await findInviteByTokenOrThrow(token);
  return {
    businessName: invite.businesses.name,
    fullName: invite.full_name,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expires_at,
  };
}

export async function acceptStaffInvite(
  token: string,
  input: AcceptInviteInput,
  requestMeta: { ipAddress?: string; userAgent?: string }
) {
  // Re-validated here rather than trusting a prior getInvitePreview call, closing the
  // gap between "preview shown" and "accept submitted" (invite could expire/get revoked
  // in between).
  const invite = await findInviteByTokenOrThrow(token);

  const passwordHash = await hashPassword(input.password);
  const now = new Date();

  const user = await prisma.$transaction(async (tx) => {
    // Claim the invite first, atomically, scoped to accepted_at: null. If a concurrent
    // request already claimed it, this matches zero rows and we roll back before ever
    // touching `users` -- not relying on an incidental unique-constraint collision on
    // users.email/phone as the only safety net against a duplicate account.
    const claim = await tx.staff_invites.updateMany({
      where: { id: invite.id, accepted_at: null },
      data: { accepted_at: now },
    });
    if (claim.count === 0) {
      throw conflict("This invitation has already been accepted");
    }

    const newUser = await tx.users.create({
      data: {
        id: generateId(),
        business_id: invite.business_id,
        name: invite.full_name,
        email: invite.email,
        phone: invite.phone,
        role: invite.role,
        password_hash: passwordHash,
        status: "active",
        activated_at: now,
        email_verified_at: now,
        terms_accepted_at: now,
        terms_version: CURRENT_TERMS_VERSION,
        privacy_accepted_at: now,
        privacy_version: CURRENT_PRIVACY_VERSION,
      },
    });

    await recordPasswordHistory(tx, newUser.id, passwordHash);

    await tx.staff_invites.update({
      where: { id: invite.id },
      data: { user_id: newUser.id },
    });

    await writeAuditLog(tx, {
      businessId: invite.business_id,
      userId: newUser.id,
      userName: newUser.name,
      userRole: newUser.role,
      action: "staff_invite.accepted",
      entityType: "user",
      entityId: newUser.id,
      reason: "Invitee accepted staff invitation and activated account",
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
    });

    return newUser;
  });

  await getNotificationProvider().send({
    category: "TRANSACTIONAL",
    channel: "email",
    to: user.email,
    subject: `Your ${invite.businesses.name} account is active`,
    body: `Your account has been activated. You can now log in with your email and password.`,
  });

  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    businessName: invite.businesses.name,
    activatedAt: user.activated_at,
  };
}
