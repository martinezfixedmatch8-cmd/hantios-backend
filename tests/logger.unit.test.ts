import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { logRequest, logUnhandledError } from "../src/lib/logger";

// Batch 8 Session B (HNT-OBS-001) -- proves the structured logger's
// allowlist and redaction guarantees both at the unit level (calling the
// logger functions directly with deliberately hostile inputs) and via a
// real end-to-end HTTP request carrying nested sensitive sentinel values,
// per the explicit requirement that this be proven by test, not asserted
// by code review alone.
describe("Structured logger -- allowlist + redaction", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("logRequest -- unit level", () => {
    it("emits exactly the allowlisted fields, nothing else", () => {
      logRequest({ method: "GET", path: "/sales/123", status: 200, durationMs: 42, requestId: "req-1", businessId: "biz-1" });
      const line = logSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(Object.keys(parsed).sort()).toEqual(["businessId", "durationMs", "event", "level", "method", "path", "requestId", "status"].sort());
      expect(parsed).toEqual({
        level: "info",
        event: "request",
        method: "GET",
        path: "/sales/123",
        status: 200,
        durationMs: 42,
        requestId: "req-1",
        businessId: "biz-1",
      });
    });

    it("omits businessId entirely (not a null/empty field) when absent", () => {
      logRequest({ method: "GET", path: "/health", status: 200, durationMs: 1, requestId: "req-2" });
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect("businessId" in parsed).toBe(false);
    });

    it("a caller passing extra properties on the input object can never smuggle them into the logged line", () => {
      const hostileInput = {
        method: "POST",
        path: "/debts",
        status: 201,
        durationMs: 5,
        requestId: "req-3",
        password: "SENTINEL_SHOULD_NEVER_LOG",
        authorization: "Bearer SENTINEL_TOKEN",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      logRequest(hostileInput);
      const line = logSpy.mock.calls[0][0] as string;
      expect(line).not.toContain("SENTINEL_SHOULD_NEVER_LOG");
      expect(line).not.toContain("SENTINEL_TOKEN");
      expect(line).not.toContain("password");
      expect(line).not.toContain("authorization");
    });
  });

  describe("logUnhandledError -- unit level, safe-message policy", () => {
    it("logs only errorName + a known-safe errorCode -- never .message or .stack", () => {
      const err = Object.assign(new Error("password=SENTINEL_PW_IN_MESSAGE account=SENTINEL_ACCT"), { code: "P2002" });
      logUnhandledError({ requestId: "req-4", method: "POST", path: "/sales" }, err);
      const line = errorSpy.mock.calls[0][0] as string;
      expect(line).not.toContain("SENTINEL_PW_IN_MESSAGE");
      expect(line).not.toContain("SENTINEL_ACCT");
      expect(line).not.toContain(err.stack ?? "__no_stack__");
      const parsed = JSON.parse(line);
      expect(parsed.errorName).toBe("Error");
      expect(parsed.errorCode).toBe("P2002");
      expect(parsed).not.toHaveProperty("message");
      expect(parsed).not.toHaveProperty("stack");
    });

    it("rejects a malformed/spoofed .code that doesn't match the safe taxonomy pattern", () => {
      const err = Object.assign(new Error("boom"), { code: "not a safe code; DROP TABLE users; --" });
      logUnhandledError({ requestId: "req-5", method: "GET", path: "/x" }, err);
      const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(parsed).not.toHaveProperty("errorCode");
    });

    it("handles a thrown non-Error value without leaking its content", () => {
      logUnhandledError({ requestId: "req-6", method: "GET", path: "/x" }, "SENTINEL_RAW_STRING_THROW");
      const line = errorSpy.mock.calls[0][0] as string;
      expect(line).not.toContain("SENTINEL_RAW_STRING_THROW");
      const parsed = JSON.parse(line);
      expect(parsed.errorName).toBe("string");
    });
  });

  describe("end-to-end -- a real request with nested objects/arrays of sensitive sentinels", () => {
    const SENTINELS = [
      "SENTINEL_PASSWORD_abc123",
      "SENTINEL_OTP_998877",
      "SENTINEL_TOKEN_xyz789",
      "SENTINEL_IBAN_DE89370400440532013000",
      "SENTINEL_PHONE_+254700000999",
      "SENTINEL_EMAIL_leaktest@example.com",
    ];

    it("never logs any sentinel value present in a real request's body (including nested objects and arrays), headers, or cookies", async () => {
      logSpy.mockClear();
      errorSpy.mockClear();

      await request(app)
        .post("/auth/login")
        .set("Authorization", `Bearer SENTINEL_TOKEN_xyz789`)
        .set("Cookie", "refresh_token=SENTINEL_TOKEN_xyz789")
        .send({
          email: "leaktest@example.com",
          password: "SENTINEL_PASSWORD_abc123",
          nested: {
            otp: "SENTINEL_OTP_998877",
            paymentInstrument: { iban: "SENTINEL_IBAN_DE89370400440532013000" },
          },
          items: [{ phone: "SENTINEL_PHONE_+254700000999" }, { note: "SENTINEL_EMAIL_leaktest@example.com" }],
        });

      const allCapturedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((call) => call.map(String).join(" ")).join("\n");

      for (const sentinel of SENTINELS) {
        expect(allCapturedText).not.toContain(sentinel);
      }
    });
  });
});
