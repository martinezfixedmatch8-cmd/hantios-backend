import { Prisma, type users } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { hashPassword, verifyPassword, recordPasswordHistory, isPasswordReused } from "../lib/password";
import { writeAuditLog } from "../lib/auditLog";
import { badRequest, conflict, forbidden, locked, notFound, unauthorized } from "../lib/errors";
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION, env } from "../lib/config";
import { getNotificationProvider } from "../notifications/registry";
import { renderEmailTemplate } from "../notifications/EmailTemplateRenderer";
import { getGoogleAuthProvider, type GoogleIdentity } from "../lib/googleAuth";
import { getCountryDefaults, findCountry, isValidTimezoneForCountry, isValidPhonePrefixForCountry } from "../lib/countryReference";
import { createOtpChallenge, verifyOtpChallenge } from "../lib/otp";
import { issueSession, rotateSession, revokeSession, invalidateUserSessions } from "../lib/session";
import { generateSecureToken, hashToken } from "../lib/tokens";
import { requiresOtpForNewDevices } from "../lib/businessSettings";
import { signAccessToken } from "../lib/jwt";
import { createEmailVerificationToken, sendEmailVerificationNotification } from "./emailVerification.service";
import type {
  SignupInput,
  LoginInput,
  GoogleLoginInput,
  GoogleIdentifyInput,
  VerifyDeviceOtpInput,
  VerifySignupPhoneOtpInput,
  ForgotPasswordInput,
  ResetPasswordInput,
} from "../validation/auth.schema";

const PASSWORD_RESET_EXPIRY_MINUTES = 60;

interface RequestMeta {
  deviceId: string;
  ipAddress?: string;
  userAgent?: string;
}

interface AuthResult {
  accessToken: string;
  rawRefreshToken: string;
  rememberMe: boolean;
  user: { id: string; name: string; email: string; role: string };
  business: { id: string; name: string };
}

interface OtpRequiredResult {
  requiresOtp: true;
  challengeId: string;
}

const FAILED_LOGIN_LOCK_THRESHOLD = 5;
const FAILED_LOGIN_LOCK_MINUTES = 15;

function toAccessToken(user: users): string {
  return signAccessToken({
    sub: user.id,
    businessId: user.business_id,
    role: user.role,
    name: user.name,
    sessionVersion: user.session_version,
  });
}

// A client can override currency/timezone/phonePrefix explicitly (see
// countryReference.ts's own comment on why), but never trust that override
// blindly -- validate it's actually consistent with the selected country
// server-side. Never rely on frontend validation for this.
async function resolveCountryFields(input: {
  country: string;
  currency?: string;
  timezone?: string;
  phonePrefix?: string;
}) {
  const defaults = getCountryDefaults(input.country);

  if (input.timezone && !isValidTimezoneForCountry(input.country, input.timezone)) {
    throw badRequest("Selected timezone does not belong to the selected country");
  }
  if (input.currency) {
    const country = findCountry(input.country);
    const validCurrencies = Object.keys(country?.currencies ?? {});
    if (!validCurrencies.includes(input.currency)) {
      throw badRequest("Selected currency does not belong to the selected country");
    }
  }
  if (input.phonePrefix && !isValidPhonePrefixForCountry(input.country, input.phonePrefix)) {
    throw badRequest("Selected phone prefix does not belong to the selected country");
  }

  return {
    currency: input.currency ?? defaults.currency,
    timezone: input.timezone ?? defaults.timezone,
    phonePrefix: input.phonePrefix ?? defaults.phonePrefix,
  };
}

export async function signup(input: SignupInput, meta: RequestMeta): Promise<AuthResult> {
  const email = input.provider === "email" ? input.businessEmail : undefined;
  let googleIdentity: GoogleIdentity | undefined;

  if (input.provider === "google") {
    googleIdentity = await getGoogleAuthProvider().verifyIdToken(input.idToken);
  }

  const resolvedEmail = (input.provider === "email" ? email : googleIdentity!.email)!;

  const existing = await prisma.users.findUnique({ where: { email: resolvedEmail } });
  if (existing) {
    throw conflict("An account with this email already exists");
  }

  const { currency, timezone, phonePrefix } = await resolveCountryFields(input);
  const passwordHash = input.provider === "email" ? await hashPassword(input.password) : null;
  const now = new Date();

  const created = await prisma.$transaction(async (tx) => {
    const business = await tx.businesses.create({
      data: {
        id: generateId(),
        name: input.businessName,
        plan: "starter",
        tier: "tier1",
        country: input.country,
        phone_prefix: phonePrefix,
        timezone,
        currency,
      },
    });

    const ownerName =
      input.provider === "email" ? input.ownerFullName : input.ownerFullName ?? googleIdentity!.name;

    // The pre-transaction findUnique above is a courtesy check, not the real guard -- a
    // concurrent signup with the same email can still race past it, so the unique
    // constraint itself is the actual source of truth. Without this catch, that race
    // surfaces as an uncaught P2002 -> generic 500 instead of a clean 409 (same TOCTOU
    // class as the staff-invite accept race fixed earlier in this repo's history).
    let user;
    try {
      user = await tx.users.create({
        data: {
          id: generateId(),
          business_id: business.id,
          name: ownerName,
          email: resolvedEmail,
          phone: input.phone,
          password_hash: passwordHash,
          role: "owner",
          status: "active",
          activated_at: now,
          oauth_provider: input.provider === "google" ? "google" : undefined,
          oauth_provider_id: input.provider === "google" ? googleIdentity!.sub : undefined,
          email_verified_at: input.provider === "google" && googleIdentity!.emailVerified ? now : null,
          terms_accepted_at: now,
          terms_version: CURRENT_TERMS_VERSION,
          privacy_accepted_at: now,
          privacy_version: CURRENT_PRIVACY_VERSION,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw conflict("An account with this email already exists");
      }
      throw err;
    }

    await tx.businesses.update({ where: { id: business.id }, data: { owner_id: user.id } });

    if (passwordHash) {
      await recordPasswordHistory(tx, user.id, passwordHash);
    }

    const phoneOtp = await createOtpChallenge(tx, { businessId: business.id, userId: user.id, purpose: "signup" });

    let emailVerificationToken: string | undefined;
    if (input.provider === "email") {
      const result = await createEmailVerificationToken(tx, user.id);
      emailVerificationToken = result.token;
    }

    const { rawRefreshToken } = await issueSession(tx, {
      userId: user.id,
      businessId: business.id,
      rememberMe: input.rememberMe,
      deviceId: meta.deviceId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    await writeAuditLog(tx, {
      businessId: business.id,
      userId: user.id,
      userName: user.name,
      userRole: user.role,
      action: "auth.signup",
      entityType: "business",
      entityId: business.id,
      reason: `Business signup via ${input.provider}`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { business, user, phoneOtp, emailVerificationToken, rawRefreshToken };
  });

  await getNotificationProvider().send({
    category: "TRANSACTIONAL",
    channel: "whatsapp",
    to: created.user.phone,
    businessId: created.business.id,
    body: `Your HantiOS phone verification code is ${created.phoneOtp.code}. It expires in 10 minutes.`,
  });

  if (created.emailVerificationToken) {
    await sendEmailVerificationNotification(created.user, created.emailVerificationToken);
  }

  return {
    accessToken: toAccessToken(created.user),
    rawRefreshToken: created.rawRefreshToken,
    rememberMe: input.rememberMe,
    user: { id: created.user.id, name: created.user.name, email: created.user.email, role: created.user.role },
    business: { id: created.business.id, name: created.business.name },
  };
}

export async function verifySignupPhoneOtp(input: VerifySignupPhoneOtpInput): Promise<void> {
  const { userId } = await verifyOtpChallenge(prisma, input.challengeId, input.code, "signup");
  await prisma.users.update({ where: { id: userId }, data: { phone_verified_at: new Date() } });
}

async function recordFailedLogin(user: users, email: string, meta: RequestMeta, reason: string): Promise<void> {
  const attempts = user.failed_login_attempts + 1;
  const shouldLock = attempts >= FAILED_LOGIN_LOCK_THRESHOLD;
  await prisma.users.update({
    where: { id: user.id },
    data: {
      failed_login_attempts: attempts,
      locked_until: shouldLock ? new Date(Date.now() + FAILED_LOGIN_LOCK_MINUTES * 60 * 1000) : user.locked_until,
    },
  });
  await prisma.login_events.create({
    data: {
      id: generateId(),
      business_id: user.business_id,
      user_id: user.id,
      email,
      success: false,
      method: "password",
      ip_address: meta.ipAddress,
      user_agent: meta.userAgent,
      device_id: meta.deviceId,
      failure_reason: reason,
    },
  });
}

async function completeLogin(
  user: users,
  method: "password" | "google",
  meta: RequestMeta,
  rememberMe: boolean
): Promise<AuthResult> {
  // Batch 2 remediation -- closes the other half of HNT2-AUTH-001: without
  // this, a deactivated account could still complete a brand-new login
  // (password, Google, or device-OTP) and mint a fresh token whose
  // session_version naturally matches the current DB value, sailing
  // straight past authenticate.ts's own revocation check. A non-active
  // account must never reach a session at all, not just lose existing ones.
  if (user.status !== "active") {
    throw forbidden("This account is not active");
  }

  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: user.business_id } });

  await prisma.users.update({
    where: { id: user.id },
    data: { failed_login_attempts: 0, locked_until: null, last_login: new Date() },
  });
  await prisma.login_events.create({
    data: {
      id: generateId(),
      business_id: user.business_id,
      user_id: user.id,
      email: user.email,
      success: true,
      method,
      ip_address: meta.ipAddress,
      user_agent: meta.userAgent,
      device_id: meta.deviceId,
    },
  });

  const { rawRefreshToken } = await issueSession(prisma, {
    userId: user.id,
    businessId: user.business_id,
    rememberMe,
    deviceId: meta.deviceId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  return {
    accessToken: toAccessToken(user),
    rawRefreshToken,
    rememberMe,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    business: { id: business.id, name: business.name },
  };
}

async function challengeNewDeviceIfNeeded(
  user: users,
  meta: RequestMeta
): Promise<OtpRequiredResult | null> {
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: user.business_id } });
  if (!requiresOtpForNewDevices(business.settings)) {
    return null;
  }

  // A device only counts as "known" while it has an active session -- not merely because
  // it had one at some point. Logging out (or a session expiring) resets that device's
  // trust, matching "unrecognized device triggers OTP" literally rather than granting
  // permanent recognition off a single historical session.
  const knownDevice = await prisma.sessions.findFirst({
    where: { user_id: user.id, device_id: meta.deviceId, revoked_at: null, expires_at: { gt: new Date() } },
  });
  if (knownDevice) {
    return null;
  }

  const challenge = await createOtpChallenge(prisma, {
    businessId: user.business_id,
    userId: user.id,
    purpose: "new_device_login",
  });
  await getNotificationProvider().send({
    category: "SECURITY",
    channel: "whatsapp",
    to: user.phone,
    businessId: user.business_id,
    body: `A login from a new device requires verification. Your HantiOS code is ${challenge.code}. It expires in 10 minutes.`,
  });
  return { requiresOtp: true, challengeId: challenge.id };
}

export async function login(input: LoginInput, meta: RequestMeta): Promise<AuthResult | OtpRequiredResult> {
  const user = await prisma.users.findUnique({ where: { email: input.email } });
  if (!user || !user.password_hash) {
    if (user) {
      await recordFailedLogin(user, input.email, meta, "no_password_set");
    }
    throw unauthorized("Invalid email or password");
  }

  if (user.locked_until && user.locked_until > new Date()) {
    throw locked("Account temporarily locked due to repeated failed login attempts");
  }

  const validPassword = await verifyPassword(input.password, user.password_hash);
  if (!validPassword) {
    await recordFailedLogin(user, input.email, meta, "invalid_password");
    throw unauthorized("Invalid email or password");
  }

  const otpRequired = await challengeNewDeviceIfNeeded(user, meta);
  if (otpRequired) return otpRequired;

  return completeLogin(user, "password", meta, input.rememberMe);
}

export async function googleIdentify(input: GoogleIdentifyInput) {
  const identity = await getGoogleAuthProvider().verifyIdToken(input.idToken);
  const user = await prisma.users.findUnique({ where: { email: identity.email } });
  return {
    exists: !!user,
    hasPasswordAccount: !!user?.password_hash,
    email: identity.email,
    name: identity.name,
  };
}

export async function googleLogin(input: GoogleLoginInput, meta: RequestMeta): Promise<AuthResult | OtpRequiredResult> {
  const identity = await getGoogleAuthProvider().verifyIdToken(input.idToken);
  const user = await prisma.users.findUnique({ where: { email: identity.email } });

  if (!user) {
    throw notFound("No account found for this Google identity, please sign up");
  }
  if (user.oauth_provider !== "google") {
    throw conflict("An account with this email already exists, log in with your password instead");
  }
  if (user.oauth_provider_id !== identity.sub) {
    throw unauthorized("Invalid Google credential");
  }

  const otpRequired = await challengeNewDeviceIfNeeded(user, meta);
  if (otpRequired) return otpRequired;

  return completeLogin(user, "google", meta, input.rememberMe);
}

export async function verifyDeviceOtp(input: VerifyDeviceOtpInput, meta: RequestMeta): Promise<AuthResult> {
  const { userId } = await verifyOtpChallenge(prisma, input.challengeId, input.code, "new_device_login");
  const user = await prisma.users.findUniqueOrThrow({ where: { id: userId } });
  return completeLogin(user, "password", meta, input.rememberMe);
}

export async function refresh(
  rawRefreshToken: string,
  meta: Partial<RequestMeta>
): Promise<{ accessToken: string; rawRefreshToken: string; rememberMe: boolean }> {
  const rotated = await rotateSession(prisma, rawRefreshToken, meta);
  const user = await prisma.users.findUniqueOrThrow({ where: { id: rotated.userId } });
  // Batch 2 remediation -- refresh() already re-fetches the user fresh from
  // the DB on every call (unlike the access token, which only carries a
  // point-in-time snapshot), so this check was nearly free to add: a
  // deactivated account can no longer mint a new access token via refresh
  // either, even if its refresh-token cookie is technically still valid and
  // unexpired.
  if (user.status !== "active") {
    await revokeSession(prisma, rotated.rawRefreshToken);
    throw unauthorized("This account is not active");
  }
  return {
    accessToken: toAccessToken(user),
    rawRefreshToken: rotated.rawRefreshToken,
    rememberMe: rotated.rememberMe,
  };
}

export async function logout(rawRefreshToken: string): Promise<void> {
  await revokeSession(prisma, rawRefreshToken);
}

// Batch 2 remediation (HNT2-AUTH-001) -- explicit "log out everywhere,"
// named directly in the finding's own session_version-bump trigger list.
// Authenticated (the caller must already hold a valid access token for the
// account being logged out) -- this is "kill my own other sessions," not an
// admin action against someone else.
export async function logoutAll(userId: string): Promise<void> {
  await invalidateUserSessions(prisma, userId);
}

// Batch 2 remediation (HNT-AUTH-003) -- always a generic response
// regardless of whether the email exists, so this can never be used to
// enumerate real accounts. Rate-limited at the route layer
// (passwordResetRequestLimiter), not here.
export async function requestPasswordReset(input: ForgotPasswordInput): Promise<void> {
  const user = await prisma.users.findUnique({ where: { email: input.email } });
  // No password_hash means a Google-only account -- there is no password to
  // reset. Silently no-op, same "never reveal account existence/shape"
  // reasoning as the not-found case.
  if (!user || !user.password_hash) {
    return;
  }

  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60 * 1000);
  await prisma.password_reset_tokens.create({
    data: {
      id: generateId(),
      business_id: user.business_id,
      user_id: user.id,
      token_hash: hashToken(token),
      expires_at: expiresAt,
    },
  });

  const resetUrl = `${env.APP_BASE_URL}/reset-password/${token}`;
  const { subject, body } = renderEmailTemplate("password_reset_requested", { name: user.name, resetUrl });
  await getNotificationProvider().send({
    category: "SECURITY",
    channel: "email",
    to: user.email,
    businessId: user.business_id,
    senderProfile: "SECURITY",
    subject,
    body,
  });
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const tokenHash = hashToken(input.token);
  const record = await prisma.password_reset_tokens.findUnique({ where: { token_hash: tokenHash } });
  if (!record || record.consumed_at || record.expires_at < new Date()) {
    throw badRequest("Invalid or expired reset link");
  }

  const user = await prisma.users.findUniqueOrThrow({ where: { id: record.user_id } });
  if (await isPasswordReused(prisma, user.id, input.newPassword)) {
    throw badRequest("This password was used recently -- choose a different one");
  }
  const passwordHash = await hashPassword(input.newPassword);

  await prisma.$transaction(async (tx) => {
    // Atomic conditional claim -- same shape as otp.ts's own fix: a
    // concurrent second use of the identical link (double-submit, a
    // replayed request) is rejected here even if it passed the read-based
    // checks above, since count===0 means someone else already consumed it
    // since that read.
    const claim = await tx.password_reset_tokens.updateMany({
      where: { id: record.id, consumed_at: null, expires_at: { gt: new Date() } },
      data: { consumed_at: new Date() },
    });
    if (claim.count === 0) {
      throw badRequest("Invalid or expired reset link");
    }

    await tx.users.update({ where: { id: user.id }, data: { password_hash: passwordHash } });
    await recordPasswordHistory(tx, user.id, passwordHash);
    // HNT-AUTH-003's own explicit requirement: revoke every session and
    // invalidate every already-issued access token, not just the one used
    // to request this reset (there may be none -- password reset works
    // while logged out).
    await invalidateUserSessions(tx, user.id);

    await writeAuditLog(tx, {
      businessId: user.business_id,
      userId: user.id,
      userName: user.name,
      userRole: user.role,
      action: "auth.password_reset",
      entityType: "user",
      entityId: user.id,
      reason: "Password reset via emailed link",
    });
  });

  const { subject, body } = renderEmailTemplate("password_reset_completed", { name: user.name });
  await getNotificationProvider().send({
    category: "SECURITY",
    channel: "email",
    to: user.email,
    businessId: user.business_id,
    senderProfile: "SECURITY",
    subject,
    body,
  });
}
