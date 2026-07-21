import rateLimit from "express-rate-limit";
import { env } from "../lib/config";

const isTestEnv = env.NODE_ENV === "test";

export const inviteCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isTestEnv ? 10_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
});

export const inviteTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10_000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
});

export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isTestEnv ? 10_000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
});

export const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
});

export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10_000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
});

export const verifyEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10_000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// Tightest ceiling: 6-digit codes are brute-forceable. otp_challenges.max_attempts (5) is
// the per-challenge backstop; this is the per-IP backstop.
export const verifyOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10_000 : 15,
  standardHeaders: true,
  legacyHeaders: false,
});
