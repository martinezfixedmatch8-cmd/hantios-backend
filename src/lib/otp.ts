import { randomInt } from "crypto";
import type { OtpPurpose, Prisma, PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "./password";
import { generateId } from "./ids";
import { badRequest, gone } from "./errors";

type Db = PrismaClient | Prisma.TransactionClient;

const OTP_EXPIRY_MINUTES = 10;

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export async function createOtpChallenge(
  db: Db,
  input: { businessId: string; userId: string; purpose: OtpPurpose }
): Promise<{ id: string; code: string }> {
  const code = generateOtpCode();
  const codeHash = await hashPassword(code);
  const challenge = await db.otp_challenges.create({
    data: {
      id: generateId(),
      business_id: input.businessId,
      user_id: input.userId,
      purpose: input.purpose,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
    },
  });
  return { id: challenge.id, code };
}

export async function verifyOtpChallenge(
  db: Db,
  challengeId: string,
  code: string
): Promise<{ userId: string; businessId: string }> {
  const challenge = await db.otp_challenges.findUnique({ where: { id: challengeId } });
  if (!challenge) {
    throw badRequest("Invalid or expired code");
  }
  if (challenge.consumed_at) {
    throw gone("This code has already been used");
  }
  if (challenge.expires_at < new Date()) {
    throw gone("This code has expired, request a new one");
  }
  if (challenge.attempts >= challenge.max_attempts) {
    throw gone("Too many incorrect attempts, request a new code");
  }

  const isValid = await verifyPassword(code, challenge.code_hash);
  if (!isValid) {
    await db.otp_challenges.update({
      where: { id: challengeId },
      data: { attempts: { increment: 1 } },
    });
    throw badRequest("Incorrect code");
  }

  await db.otp_challenges.update({
    where: { id: challengeId },
    data: { consumed_at: new Date() },
  });

  return { userId: challenge.user_id, businessId: challenge.business_id };
}
