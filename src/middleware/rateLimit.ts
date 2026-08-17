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

// Batch 2 remediation (HNT-AUTH-003) -- tight ceiling: this endpoint's own
// generic-response-regardless-of-existence design is the primary defense
// against enumeration, but a flood of requests is still real, unwanted
// work (a DB write + an email send per call) with no legitimate reason to
// happen often for one IP.
export const passwordResetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10_000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
});

// PO Negotiation supplier portal -- public, token-authenticated, no JWT.
// "30 requests/min per IP per link" per the locked spec, literally: a 1-
// minute window, not inviteTokenLimiter's 15-minute one (that limiter's
// numbers don't transfer here despite the similar "public token route"
// shape).
export const supplierPortalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTestEnv ? 10_000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// Module 33 Session 4B -- Resend's inbound webhook, a public endpoint with
// no user identity to key a per-account limit off of (the request is
// Resend's own infrastructure calling us, not a logged-in user or even a
// token-holding supplier). This is a defensive ceiling against a flood of
// requests to a known public URL, not a legitimate-traffic constraint --
// genuine webhook volume (even real bursts of near-simultaneous supplier
// replies) sits nowhere near this. Every request still passes through
// signature verification regardless of rate-limit status; this only bounds
// how much work an unauthenticated flood can make the server do.
export const resendWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTestEnv ? 10_000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
});
