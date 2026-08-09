import { Webhook, WebhookVerificationError } from "svix";

// Module 33 Session 4B -- Resend delivers webhooks via Svix's own
// infrastructure (confirmed directly: Resend's SDK itself has no built-in
// verification helper -- its `Webhooks` class only manages webhook
// *configuration*, not payload verification -- and `svix`'s own installed
// package wraps `standardwebhooks`, the real HMAC-SHA256 + timestamp-
// tolerance implementation). This is NOT the Resend SDK -- svix is a
// separate, unbranded webhook-delivery-verification library, so importing
// it here does not touch the ARCHITECTURE LOCK (which is specifically
// about the Resend package itself; tests/emailArchitectureLock.unit.test.ts
// scans every file for that exact package specifier, not for this one).
export interface WebhookHeaders {
  "svix-id"?: string;
  "svix-timestamp"?: string;
  "svix-signature"?: string;
}

// Fail-closed (Lock #6): returns the verified, parsed payload on success,
// or null for EVERY failure mode -- no configured secret, missing/partial
// headers, or an invalid signature -- never throws. `secret` is an explicit
// parameter rather than an internal env.RESEND_WEBHOOK_SECRET read, the
// same reasoning ResendEmailProvider's own fromEmail already established:
// keeps this deterministically testable with a known test secret, since a
// test can then use svix's own real Webhook.sign() to build an
// authentically-signed payload rather than needing to fake cryptography.
export function verifyResendWebhookSignature(rawBody: Buffer | string, headers: WebhookHeaders, secret: string | undefined): unknown | null {
  if (!secret) return null;
  if (!headers["svix-id"] || !headers["svix-timestamp"] || !headers["svix-signature"]) return null;

  try {
    const webhook = new Webhook(secret);
    return webhook.verify(rawBody, {
      "svix-id": headers["svix-id"],
      "svix-timestamp": headers["svix-timestamp"],
      "svix-signature": headers["svix-signature"],
    });
  } catch (err) {
    if (err instanceof WebhookVerificationError) return null;
    // Defensive -- a webhook-verification failure must never surface as an
    // unhandled exception regardless of cause.
    return null;
  }
}
