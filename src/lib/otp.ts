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

// Batch 2 remediation (HNT-AUTH-001 + HNT-AUTH-002).
//
// expectedPurpose is now required, not optional -- a challenge created for
// signup phone verification must never be consumable at the device-login
// endpoint (or any other purpose's endpoint) even if a caller passes a
// bare, valid challengeId across contexts. Every call site now passes its
// own fixed, hardcoded purpose constant (never a client-suppliable value),
// so this can't be defeated by a client simply sending a different purpose.
//
// The real fix is the atomic claim at the end. The original version did a
// read-check-write sequence with a plain (non-conditional) UPDATE as the
// final "consume" step -- two concurrent requests presenting the SAME
// correct code could both pass every check (both reads see consumed_at:
// null) and both successfully consume, both completing login/verification
// from a single OTP send. This function still reads first (needed to run
// bcrypt.compare, which can't be expressed inside a SQL WHERE clause), but
// the actual claim is a single conditional updateMany re-checking every
// precondition fresh -- purpose, consumed_at, expires_at, attempts -- at
// the moment of the write, not the moment of the earlier read. count===0
// means someone else (or a stale/expired state) already won the race
// since the read; that request is correctly rejected even though its own
// read looked valid.
export async function verifyOtpChallenge(
  db: Db,
  challengeId: string,
  code: string,
  expectedPurpose: OtpPurpose
): Promise<{ userId: string; businessId: string }> {
  const challenge = await db.otp_challenges.findUnique({ where: { id: challengeId } });
  // Same generic message whether the challenge doesn't exist at all or
  // exists but belongs to a different purpose -- never leak which case it
  // was to the caller.
  if (!challenge || challenge.purpose !== expectedPurpose) {
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
    // Conditional on consumed_at: null too -- if this challenge was
    // consumed by a concurrent correct-code request in the gap since the
    // read above, don't also bump attempts on an already-resolved row.
    await db.otp_challenges.updateMany({
      where: { id: challengeId, consumed_at: null },
      data: { attempts: { increment: 1 } },
    });
    throw badRequest("Incorrect code");
  }

  const claim = await db.otp_challenges.updateMany({
    where: {
      id: challengeId,
      purpose: expectedPurpose,
      consumed_at: null,
      expires_at: { gt: new Date() },
      attempts: { lt: challenge.max_attempts },
    },
    data: { consumed_at: new Date() },
  });
  if (claim.count === 0) {
    throw gone("This code has already been used");
  }

  return { userId: challenge.user_id, businessId: challenge.business_id };
}
