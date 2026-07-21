import type { Response } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { generateId } from "./ids";
import { generateSecureToken, hashToken } from "./tokens";
import { env } from "./config";
import { unauthorized } from "./errors";

type Db = PrismaClient | Prisma.TransactionClient;

export const REFRESH_COOKIE_NAME = "refresh_token";
export const CSRF_COOKIE_NAME = "csrf_token";
const COOKIE_PATH = "/auth";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // always 7 days, regardless of rememberMe
const REMEMBER_ME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

interface SessionMeta {
  deviceId: string;
  ipAddress?: string;
  userAgent?: string;
}

export async function issueSession(
  db: Db,
  input: { userId: string; businessId: string; rememberMe: boolean } & SessionMeta
): Promise<{ sessionId: string; rawRefreshToken: string }> {
  const rawRefreshToken = generateSecureToken();
  const session = await db.sessions.create({
    data: {
      id: generateId(),
      business_id: input.businessId,
      user_id: input.userId,
      refresh_token_hash: hashToken(rawRefreshToken),
      device_id: input.deviceId,
      ip_address: input.ipAddress,
      user_agent: input.userAgent,
      remember_me: input.rememberMe,
      expires_at: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return { sessionId: session.id, rawRefreshToken };
}

export async function rotateSession(
  db: Db,
  rawRefreshToken: string,
  meta: Partial<SessionMeta>
): Promise<{ sessionId: string; userId: string; businessId: string; rememberMe: boolean; rawRefreshToken: string }> {
  const session = await db.sessions.findFirst({
    where: { refresh_token_hash: hashToken(rawRefreshToken) },
  });
  if (!session || session.revoked_at || session.expires_at < new Date()) {
    throw unauthorized("Session expired or invalid, please log in again");
  }

  const newRawRefreshToken = generateSecureToken();
  await db.sessions.update({
    where: { id: session.id },
    data: {
      refresh_token_hash: hashToken(newRawRefreshToken),
      // Unconditional 7-day slide -- remember_me governs the cookie's Max-Age, not this.
      expires_at: new Date(Date.now() + SESSION_TTL_MS),
      last_active_at: new Date(),
      ip_address: meta.ipAddress ?? session.ip_address,
      user_agent: meta.userAgent ?? session.user_agent,
    },
  });

  return {
    sessionId: session.id,
    userId: session.user_id,
    businessId: session.business_id,
    rememberMe: session.remember_me,
    rawRefreshToken: newRawRefreshToken,
  };
}

export async function revokeSession(db: Db, rawRefreshToken: string): Promise<void> {
  const session = await db.sessions.findFirst({
    where: { refresh_token_hash: hashToken(rawRefreshToken) },
  });
  if (!session || session.revoked_at) {
    return;
  }
  await db.sessions.update({ where: { id: session.id }, data: { revoked_at: new Date() } });
}

export function setAuthCookies(res: Response, input: { rawRefreshToken: string; rememberMe: boolean }): void {
  const maxAge = input.rememberMe ? REMEMBER_ME_MAX_AGE_MS : DEFAULT_MAX_AGE_MS;
  const shared = {
    path: COOKIE_PATH,
    maxAge,
    secure: env.NODE_ENV === "production",
    sameSite: (env.NODE_ENV === "production" ? "none" : "lax") as "none" | "lax",
  };

  res.cookie(REFRESH_COOKIE_NAME, input.rawRefreshToken, { ...shared, httpOnly: true });
  res.cookie(CSRF_COOKIE_NAME, generateSecureToken(16), { ...shared, httpOnly: false });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE_NAME, { path: COOKIE_PATH });
}
