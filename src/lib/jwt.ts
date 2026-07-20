import jwt from "jsonwebtoken";
import type { UserRole } from "@prisma/client";
import { env } from "./config";

export interface AccessTokenPayload {
  sub: string;
  businessId: string;
  role: UserRole;
  name: string;
}

export function signAccessToken(payload: AccessTokenPayload, expiresIn = "15m"): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}
