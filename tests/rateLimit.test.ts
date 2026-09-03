import express from "express";
import request from "supertest";
import rateLimit from "express-rate-limit";
import type { Store } from "express-rate-limit";
import { RATE_LIMIT_CONFIG } from "../src/middleware/rateLimit";

// HNT-OPS-004 (Batch 9 Session A).
describe("Rate limit configuration + fail-open/fail-closed policy", () => {
  describe("regression: every limiter retains its exact window/max/passOnStoreError/prefix", () => {
    const expected = {
      inviteCreateLimiter: { windowMs: 60 * 60 * 1000, max: 20, prefix: "inviteCreate", passOnStoreError: true },
      inviteTokenLimiter: { windowMs: 15 * 60 * 1000, max: 30, prefix: "inviteToken", passOnStoreError: true },
      signupLimiter: { windowMs: 60 * 60 * 1000, max: 10, prefix: "signup", passOnStoreError: false },
      loginLimiter: { windowMs: 15 * 60 * 1000, max: 20, prefix: "login", passOnStoreError: false },
      googleAuthLimiter: { windowMs: 15 * 60 * 1000, max: 20, prefix: "googleAuth", passOnStoreError: false },
      refreshLimiter: { windowMs: 15 * 60 * 1000, max: 60, prefix: "refresh", passOnStoreError: true },
      verifyEmailLimiter: { windowMs: 15 * 60 * 1000, max: 30, prefix: "verifyEmail", passOnStoreError: true },
      verifyOtpLimiter: { windowMs: 15 * 60 * 1000, max: 15, prefix: "verifyOtp", passOnStoreError: false },
      passwordResetRequestLimiter: { windowMs: 15 * 60 * 1000, max: 5, prefix: "passwordResetRequest", passOnStoreError: false },
      supplierPortalLimiter: { windowMs: 60 * 1000, max: 30, prefix: "supplierPortal", passOnStoreError: true },
      resendWebhookLimiter: { windowMs: 60 * 1000, max: 100, prefix: "resendWebhook", passOnStoreError: true },
    } as const;

    it.each(Object.keys(expected) as (keyof typeof expected)[])("%s matches its approved configuration exactly", (name) => {
      expect(RATE_LIMIT_CONFIG[name]).toEqual(expected[name]);
    });

    it("has exactly 11 limiters -- the corrected count, not the audit's originally-claimed 10", () => {
      expect(Object.keys(RATE_LIMIT_CONFIG)).toHaveLength(11);
    });

    it("the approved fail-closed group is exactly these 5, no more, no fewer", () => {
      const failClosed = Object.entries(RATE_LIMIT_CONFIG)
        .filter(([, cfg]) => cfg.passOnStoreError === false)
        .map(([name]) => name)
        .sort();
      expect(failClosed).toEqual(
        ["googleAuthLimiter", "loginLimiter", "passwordResetRequestLimiter", "signupLimiter", "verifyOtpLimiter"].sort()
      );
    });

    it("every prefix is unique -- no accidental collision between limiters", () => {
      const prefixes = Object.values(RATE_LIMIT_CONFIG).map((c) => c.prefix);
      expect(new Set(prefixes).size).toBe(prefixes.length);
    });
  });

  // These tests verify express-rate-limit@8.6.0's OWN passOnStoreError
  // behavior against a deliberately-throwing store -- confirming the
  // library does what its own contract promises, not custom fallback code
  // written for this session (there isn't any: passOnStoreError is used
  // exactly as the library provides it).
  describe("passOnStoreError -- library-native fail-open/fail-closed, no custom code", () => {
    function throwingStore(): Store {
      return {
        increment: async () => {
          throw new Error("simulated store failure");
        },
        decrement: async () => {},
        resetKey: async () => {},
      };
    }

    function buildApp(passOnStoreError: boolean) {
      const app = express();
      app.use(
        rateLimit({
          windowMs: 60_000,
          limit: 1,
          store: throwingStore(),
          passOnStoreError,
          standardHeaders: true,
          legacyHeaders: false,
        })
      );
      app.get("/", (_req, res) => res.status(200).json({ ok: true }));
      return app;
    }

    it("passOnStoreError: false (fail-closed) -- a store failure rejects the request", async () => {
      const app = buildApp(false);
      const res = await request(app).get("/");
      expect(res.status).not.toBe(200);
    });

    it("passOnStoreError: true (fail-open) -- a store failure still lets the request through", async () => {
      const app = buildApp(true);
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });
});
