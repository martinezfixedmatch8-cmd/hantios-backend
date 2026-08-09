import { z } from "zod";

// Module 33 Session 4B -- Lock #6 (fail closed on malformed/hostile input).
// The webhook endpoint is configured in Resend's dashboard to receive
// events broadly, not just email.received -- so the OUTER envelope is
// validated loosely (any string `type`), and the specific, stricter inner
// shape is only required once `type === "email.received"` is confirmed.
// Every other event type is a legitimate, expected no-op (200, ignored),
// never a validation failure.
export const resendWebhookEnvelopeSchema = z
  .object({
    type: z.string().min(1),
    created_at: z.string().optional(),
    data: z.unknown(),
  })
  .passthrough();

export type ResendWebhookEnvelope = z.infer<typeof resendWebhookEnvelopeSchema>;

const resendInboundAttachmentSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().nullable().optional(),
    content_type: z.string().min(1),
    content_disposition: z.string().nullable().optional(),
    content_id: z.string().nullable().optional(),
  })
  .passthrough();

// Deliberately permissive on `to`/`subject` shape beyond "present" -- this
// is untrusted external input, not a client we control the shape of; the
// only thing that must be true is enough structure exists to attempt
// matching. A genuinely malformed from/to still fails cleanly downstream
// (no correlation match, no valid-looking email address to compare against
// a supplier snapshot), landing in unmatched_inbound_emails rather than
// throwing here.
export const resendInboundEmailReceivedSchema = z
  .object({
    email_id: z.string().min(1),
    from: z.string().min(1),
    to: z.array(z.string()).min(1),
    subject: z.string().optional().default(""),
    attachments: z.array(resendInboundAttachmentSchema).optional().default([]),
  })
  .passthrough();

export type ResendInboundEmailReceivedData = z.infer<typeof resendInboundEmailReceivedSchema>;
