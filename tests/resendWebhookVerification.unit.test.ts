import { verifyResendWebhookSignature } from "../src/lib/resendWebhookVerification";
import { signWebhookPayload } from "./helpers/resendWebhookSigning";

const SECRET = "whsec_dGVzdC1zZWNyZXQtZm9yLXVuaXQtdGVzdHMtb25seQ==";
const OTHER_SECRET = "whsec_ZGlmZmVyZW50LXNlY3JldC1uZXZlci1tYXRjaGVz";

describe("verifyResendWebhookSignature", () => {
  it("verifies and parses a correctly-signed payload", () => {
    const { body, headers } = signWebhookPayload({ type: "email.received", data: { email_id: "abc" } }, SECRET);
    const result = verifyResendWebhookSignature(body, headers, SECRET);
    expect(result).toEqual({ type: "email.received", data: { email_id: "abc" } });
  });

  it("returns null when no secret is configured", () => {
    const { body, headers } = signWebhookPayload({ type: "email.received" }, SECRET);
    expect(verifyResendWebhookSignature(body, headers, undefined)).toBeNull();
  });

  it("returns null when the signature was produced with a different secret", () => {
    const { body, headers } = signWebhookPayload({ type: "email.received" }, OTHER_SECRET);
    expect(verifyResendWebhookSignature(body, headers, SECRET)).toBeNull();
  });

  it("returns null when the body was tampered with after signing", () => {
    const { body, headers } = signWebhookPayload({ type: "email.received", data: { email_id: "abc" } }, SECRET);
    const tamperedBody = body.replace("abc", "xyz");
    expect(verifyResendWebhookSignature(tamperedBody, headers, SECRET)).toBeNull();
  });

  it("returns null when svix-signature header is missing", () => {
    const { body, headers } = signWebhookPayload({ type: "email.received" }, SECRET);
    const { "svix-signature": _omit, ...rest } = headers;
    expect(verifyResendWebhookSignature(body, rest, SECRET)).toBeNull();
  });

  it("returns null when svix-id header is missing", () => {
    const { body, headers } = signWebhookPayload({ type: "email.received" }, SECRET);
    const { "svix-id": _omit, ...rest } = headers;
    expect(verifyResendWebhookSignature(body, rest, SECRET)).toBeNull();
  });

  it("returns null when svix-timestamp header is missing", () => {
    const { body, headers } = signWebhookPayload({ type: "email.received" }, SECRET);
    const { "svix-timestamp": _omit, ...rest } = headers;
    expect(verifyResendWebhookSignature(body, rest, SECRET)).toBeNull();
  });

  it("returns null for a completely empty headers object", () => {
    const { body } = signWebhookPayload({ type: "email.received" }, SECRET);
    expect(verifyResendWebhookSignature(body, {}, SECRET)).toBeNull();
  });

  it("never throws even given garbage input", () => {
    expect(() => verifyResendWebhookSignature("not json {{{", { "svix-id": "a", "svix-timestamp": "b", "svix-signature": "c" }, SECRET)).not.toThrow();
  });
});
