import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateSecureToken, hashToken } from "../lib/tokens";
import { env } from "../lib/config";
import { badRequest, gone } from "../lib/errors";
import { getNotificationProvider } from "../notifications/registry";
import { renderEmailTemplate } from "../notifications/EmailTemplateRenderer";

type Db = PrismaClient | Prisma.TransactionClient;

// Persists the token (call inside the signup transaction). The actual email send happens
// separately, after commit -- see sendEmailVerificationNotification -- matching the
// established pattern in staffInvite.service.ts (DB writes in the transaction, I/O after).
export async function createEmailVerificationToken(db: Db, userId: string): Promise<{ token: string }> {
  // Batch 2 remediation (HNT-AUTH-005, extended scope) -- only the hash is
  // ever persisted now; the raw token is still emailed once, same as
  // before.
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + env.EMAIL_VERIFICATION_EXPIRY_HOURS * 60 * 60 * 1000);
  await db.users.update({
    where: { id: userId },
    data: { email_verification_token_hash: hashToken(token), email_verification_expires_at: expiresAt },
  });
  return { token };
}

export async function sendEmailVerificationNotification(
  user: { email: string; name: string; business_id: string },
  token: string
): Promise<void> {
  const verifyUrl = `${env.APP_BASE_URL}/verify-email/${token}`;
  const { subject, body } = renderEmailTemplate("email_verification", { name: user.name, verifyUrl });
  await getNotificationProvider().send({
    category: "TRANSACTIONAL",
    channel: "email",
    to: user.email,
    businessId: user.business_id,
    senderProfile: "NOREPLY",
    subject,
    body,
  });
}

export async function verifyEmail(token: string): Promise<{ userId: string }> {
  // The token hash is cleared on successful verification (below), so a
  // replayed link always fails this lookup rather than hitting an
  // "already verified" branch -- single-use by construction, not by a
  // separate already-verified check.
  const user = await prisma.users.findUnique({ where: { email_verification_token_hash: hashToken(token) } });
  if (!user) {
    throw badRequest("Invalid verification link");
  }
  if (!user.email_verification_expires_at || user.email_verification_expires_at < new Date()) {
    throw gone("This verification link has expired");
  }

  await prisma.users.update({
    where: { id: user.id },
    data: { email_verified_at: new Date(), email_verification_token_hash: null, email_verification_expires_at: null },
  });

  return { userId: user.id };
}
