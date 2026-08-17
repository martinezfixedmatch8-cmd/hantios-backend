import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { generateId } from "./ids";

// Batch 2 remediation (HNT-PWD-001) -- previously had no upper bound.
// bcrypt silently truncates its input at 72 BYTES, so an unbounded password
// let two different long inputs sharing the same first-72-byte prefix hash
// identically -- and, separately, an extremely long input is a cheap
// hashing-cost DoS vector (BCRYPT_COST=12 is deliberately expensive per
// call). 128 characters is comfortably below bcrypt's 72-byte limit for any
// realistic input while still being generous for a real passphrase; the
// point of rejecting here, before hashing, is to never depend on bcrypt's
// own silent truncation behavior in the first place.
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character");

const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function recordPasswordHistory(db: Db, userId: string, passwordHash: string): Promise<void> {
  await db.password_history.create({
    data: {
      id: generateId(),
      user_id: userId,
      password_hash: passwordHash,
    },
  });
}

const PASSWORD_HISTORY_CHECK_COUNT = 3;

// Batch 2 remediation, discovered while building password reset
// (HNT-AUTH-003) -- CLAUDE.md's own Auth Architecture section claims "last
// 3 passwords blocked from reuse (password_history, populated on every
// account-creating/password-setting path)", but a full-repo search found
// recordPasswordHistory is called on every password-setting path (real),
// while NOTHING anywhere ever reads password_history back to actually
// block reuse -- the check itself never existed. Flagged as a genuine,
// previously-undocumented gap, not assumed to already be covered. Built
// for real now and wired into the new reset-password path (the one
// password-setting path this batch adds); NOT retrofitted onto
// signup/staff-invite-accept, which are separate, already-shipped flows
// outside this batch's own scope.
export async function isPasswordReused(db: Db, userId: string, plainPassword: string): Promise<boolean> {
  const recent = await db.password_history.findMany({
    where: { user_id: userId },
    orderBy: { created_at: "desc" },
    take: PASSWORD_HISTORY_CHECK_COUNT,
  });
  for (const entry of recent) {
    if (await verifyPassword(plainPassword, entry.password_hash)) {
      return true;
    }
  }
  return false;
}
