import { randomBytes, createHash } from "crypto";

export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

// For high-entropy bearer tokens (refresh tokens) where a fast hash is appropriate --
// contrast src/lib/password.ts's bcrypt, used for low-entropy secrets (passwords, OTP codes).
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
