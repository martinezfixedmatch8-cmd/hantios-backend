import type { Request, Response } from "express";
import { env } from "../lib/config";
import { verifyResendWebhookSignature } from "../lib/resendWebhookVerification";
import { resendWebhookEnvelopeSchema, resendInboundEmailReceivedSchema } from "../validation/resendInboundWebhook.schema";
import { processResendInboundEmail } from "../services/resendInboundWebhook.service";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { domainEvents } from "../lib/events";

// Best-effort, defensive-only extraction used purely to give a genuinely
// malformed (but signature-VERIFIED) payload a chance at landing in
// unmatched_inbound_emails instead of vanishing with only a server log --
// never trusted for anything beyond that single string field.
function tryExtractEmailId(rawData: unknown): string | null {
  if (typeof rawData !== "object" || rawData === null) return null;
  const value = (rawData as Record<string, unknown>).email_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Module 33 Session 4B -- POST /api/webhooks/resend-inbound. Public, no
// RBAC (Resend's own infrastructure calls this, not a logged-in user or a
// token-holding supplier) -- signature verification is the only gate.
// Mounted in app.ts with express.raw() applied to this path specifically,
// BEFORE the app-wide express.json() -- signature verification requires
// the exact raw bytes Resend sent, not a re-serialized parse of them.
//
// Lock #6 (fail closed): every branch below either creates nothing at all
// (invalid signature) or routes through processResendInboundEmail's own
// claim-gated, fail-closed logic. Never throws past this function -- an
// unexpected error still returns a clean generic response, never a stack
// trace or internal detail, and is logged server-side only.
export async function handleResendInboundWebhook(req: Request, res: Response): Promise<void> {
  try {
    const rawBody = req.body as Buffer;
    const verified = verifyResendWebhookSignature(
      rawBody,
      {
        "svix-id": req.header("svix-id"),
        "svix-timestamp": req.header("svix-timestamp"),
        "svix-signature": req.header("svix-signature"),
      } as Record<string, string | undefined>,
      env.RESEND_WEBHOOK_SECRET
    );

    if (verified === null) {
      // Deliberately generic -- never reveal WHICH part of verification
      // failed (missing secret vs. missing headers vs. bad signature) to
      // an unauthenticated caller. No unmatched_inbound_emails row either:
      // an unverified payload's own claimed content cannot be trusted
      // enough to even log as "signature_invalid" with real field values,
      // and Lock #6 is explicit that invalid/unverifiable requests must
      // never create ANY record from their own claimed data.
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Invalid or missing webhook signature" } });
      return;
    }

    const envelopeResult = resendWebhookEnvelopeSchema.safeParse(verified);
    if (!envelopeResult.success) {
      const emailId = tryExtractEmailId((verified as { data?: unknown } | null)?.data);
      await quarantineMalformedPayload(emailId, "Envelope failed schema validation after signature verification");
      res.status(200).json({ received: true });
      return;
    }

    const envelope = envelopeResult.data;
    if (envelope.type !== "email.received") {
      // A real, expected no-op -- this webhook endpoint is configured to
      // receive Resend's event types broadly, not just inbound mail.
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    const dataResult = resendInboundEmailReceivedSchema.safeParse(envelope.data);
    if (!dataResult.success) {
      const emailId = tryExtractEmailId(envelope.data);
      await quarantineMalformedPayload(emailId, "email.received payload failed schema validation");
      res.status(200).json({ received: true });
      return;
    }

    const result = await processResendInboundEmail(dataResult.data);
    res.status(200).json({ received: true, outcome: result.outcome });
  } catch (err) {
    // Never let a webhook handler crash or leak an internal error to the
    // caller -- log server-side, acknowledge receipt regardless (Resend
    // would otherwise retry indefinitely against a payload/bug that a
    // retry can't fix, same "not a queue, don't retry forever" reasoning
    // Session 4A's own outbound retry-once already applies).
    console.error("[inbound-webhook] unexpected error processing Resend inbound webhook:", err);
    res.status(200).json({ received: true, outcome: "error" });
  }
}

// Only reachable for a SIGNATURE-VERIFIED payload whose shape still didn't
// parse -- genuinely rare (Resend's own real payloads always match), kept
// separate from processResendInboundEmail's own quarantine helper since it
// operates on a raw, not-yet-schema-validated `data` value and has no PO/
// business context to resolve at all.
async function quarantineMalformedPayload(emailId: string | null, detail: string): Promise<void> {
  console.warn(`[inbound-webhook] ${detail}${emailId ? ` (email_id: ${emailId})` : ""}`);
  if (!emailId) return; // unmatched_inbound_emails.resend_email_id is required + unique -- nothing safe to key a row on
  try {
    await prisma.unmatched_inbound_emails.create({
      data: {
        id: generateId(),
        resend_email_id: emailId,
        from_address: "",
        to_address: "",
        subject: null,
        body_preview: null,
        reason: "parse_error",
        business_id: null,
      },
    });
    domainEvents.publish("PurchaseOrderNegotiationEmailUnmatched", { businessId: null, resendEmailId: emailId, reason: "parse_error" });
  } catch {
    // A duplicate emailId (already claimed/quarantined by an earlier
    // delivery) is expected and fine to ignore here -- resend_email_id's
    // own @unique constraint is the guard, not this catch block.
  }
}
