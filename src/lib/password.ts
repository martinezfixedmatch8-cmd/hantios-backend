import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { generateId } from "./ids";

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
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
