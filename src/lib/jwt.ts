import jwt from "jsonwebtoken";
import type { UserRole } from "@prisma/client";
import { env } from "./config";

export interface AccessTokenPayload {
  sub: string;
  businessId: string;
  role: UserRole;
  name: string;
  // Batch 2 remediation (HNT2-AUTH-001) -- the value of users.session_version
  // at the moment this token was minted. authenticate.ts compares this
  // against the live DB value on every request; a mismatch (bumped by a
  // password reset, logout-all, or a future deactivation/role-change
  // endpoint) denies the request immediately, without waiting for the
  // token's own 15-minute expiry.
  sessionVersion: number;
}

export function signAccessToken(payload: AccessTokenPayload, expiresIn = "15m"): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}
