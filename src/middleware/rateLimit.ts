import rateLimit from "express-rate-limit";
import { env } from "../lib/config";
import { createPostgresRateLimitStore } from "../lib/rateLimitStore";

const isTestEnv = env.NODE_ENV === "test";

// HNT-OPS-004 (Batch 9 Session A) -- every limiter below now shares a
// distributed, Postgres-backed counter store instead of express-rate-
// limit's default per-process MemoryStore, closing the "N x instance_count
// requests instead of N" gap under horizontal scaling. See
// src/lib/rateLimitStore.ts for the store implementation and Phase 0/0.5's
// own repository-history verification for why a single-statement Postgres
// store (not Redis, not $transaction()) was the confirmed, approved choice.
//
// RATE_LIMIT_CONFIG is a single source of truth, one entry per limiter --
// every windowMs/max value below is byte-identical to what was live before
// this session; only the storage backend (store:) changed. Pulling these
// into one exported, inspectable table (rather than 11 separate inline
// rateLimit({...}) calls with no shared structure) is what makes the
// required "every limiter retains its exact window/max/passOnStoreError/
// prefix" regression test possible without a 60-minute-long behavioral
// test -- a purely structural change, zero behavior difference.
//
// Each createPostgresRateLimitStore(prefix) call gets its own PREFIX (so
// 11 limiters never collide on the same client IP in the shared table) but
// closes over the exact same imported `prisma` singleton every time --
// "a single shared instance/client reused across all limiters" is
// satisfied literally, not by constructing one giant shared JS object.
//
// passOnStoreError is the confirmed hybrid fail-open/fail-closed policy,
// per-limiter, using express-rate-limit@8.6.0's own native option -- zero
// custom fallback logic.
export const RATE_LIMIT_CONFIG = {
  inviteCreateLimiter: { windowMs: 60 * 60 * 1000, max: 20, prefix: "inviteCreate", passOnStoreError: true },
  inviteTokenLimiter: { windowMs: 15 * 60 * 1000, max: 30, prefix: "inviteToken", passOnStoreError: true },
  signupLimiter: { windowMs: 60 * 60 * 1000, max: 10, prefix: "signup", passOnStoreError: false },
  loginLimiter: { windowMs: 15 * 60 * 1000, max: 20, prefix: "login", passOnStoreError: false },
  googleAuthLimiter: { windowMs: 15 * 60 * 1000, max: 20, prefix: "googleAuth", passOnStoreError: false },
  refreshLimiter: { windowMs: 15 * 60 * 1000, max: 60, prefix: "refresh", passOnStoreError: true },
  verifyEmailLimiter: { windowMs: 15 * 60 * 1000, max: 30, prefix: "verifyEmail", passOnStoreError: true },
  // Tightest ceiling: 6-digit codes are brute-forceable. otp_challenges.max_attempts (5) is
  // the per-challenge backstop; this is the per-IP backstop.
  verifyOtpLimiter: { windowMs: 15 * 60 * 1000, max: 15, prefix: "verifyOtp", passOnStoreError: false },
  // Batch 2 remediation (HNT-AUTH-003) -- tight ceiling: this endpoint's own
  // generic-response-regardless-of-existence design is the primary defense
  // against enumeration, but a flood of requests is still real, unwanted
  // work (a DB write + an email send per call) with no legitimate reason to
  // happen often for one IP.
  passwordResetRequestLimiter: { windowMs: 15 * 60 * 1000, max: 5, prefix: "passwordResetRequest", passOnStoreError: false },
  // PO Negotiation supplier portal -- public, token-authenticated, no JWT.
  // "30 requests/min per IP per link" per the locked spec, literally: a 1-
  // minute window, not inviteTokenLimiter's 15-minute one (that limiter's
  // numbers don't transfer here despite the similar "public token route"
  // shape).
  supplierPortalLimiter: { windowMs: 60 * 1000, max: 30, prefix: "supplierPortal", passOnStoreError: true },
  // Module 33 Session 4B -- Resend's inbound webhook, a public endpoint with
  // no user identity to key a per-account limit off of (the request is
  // Resend's own infrastructure calling us, not a logged-in user or even a
  // token-holding supplier). This is a defensive ceiling against a flood of
  // requests to a known public URL, not a legitimate-traffic constraint --
  // genuine webhook volume (even real bursts of near-simultaneous supplier
  // replies) sits nowhere near this. Every request still passes through
  // signature verification regardless of rate-limit status; this only bounds
  // how much work an unauthenticated flood can make the server do.
  resendWebhookLimiter: { windowMs: 60 * 1000, max: 100, prefix: "resendWebhook", passOnStoreError: true },
} as const;

function buildLimiter(name: keyof typeof RATE_LIMIT_CONFIG) {
  const { windowMs, max, prefix, passOnStoreError } = RATE_LIMIT_CONFIG[name];
  return rateLimit({
    windowMs,
    max: isTestEnv ? 10_000 : max,
    standardHeaders: true,
    legacyHeaders: false,
    store: createPostgresRateLimitStore(prefix),
    passOnStoreError,
  });
}

export const inviteCreateLimiter = buildLimiter("inviteCreateLimiter");
export const inviteTokenLimiter = buildLimiter("inviteTokenLimiter");
export const signupLimiter = buildLimiter("signupLimiter");
export const loginLimiter = buildLimiter("loginLimiter");
export const googleAuthLimiter = buildLimiter("googleAuthLimiter");
export const refreshLimiter = buildLimiter("refreshLimiter");
export const verifyEmailLimiter = buildLimiter("verifyEmailLimiter");
export const verifyOtpLimiter = buildLimiter("verifyOtpLimiter");
export const passwordResetRequestLimiter = buildLimiter("passwordResetRequestLimiter");
export const supplierPortalLimiter = buildLimiter("supplierPortalLimiter");
export const resendWebhookLimiter = buildLimiter("resendWebhookLimiter");
