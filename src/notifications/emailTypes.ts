import type { NotificationCategory } from "@prisma/client";

// Reused verbatim, not a new 4/5-category scheme of its own -- Additional
// Requirement #1 (Module 33 Session 4A). Forward-prep for future
// unsubscribe/analytics/DKIM-per-category needs; not active logic yet.
export type EmailCategory = NotificationCategory;

// Provider-neutral attachment shape (ARCHITECTURE LOCK) -- filename/content/
// mimeType only, no Resend-specific concept. mimeType matches this repo's
// existing camelCase convention (StorageProvider's own RegisterUploadInput,
// PO Negotiation/Shipment Attachments) rather than Resend's own
// `contentType` field name -- ResendEmailProvider maps between the two
// internally, callers of this interface never see "contentType".
export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  mimeType?: string;
}

// Provider-neutral send input (ARCHITECTURE LOCK) -- only concepts common
// to every major provider. Never leak Resend-specific concepts (audience,
// broadcasts, tags, ...) here -- those stay internal to ResendEmailProvider.
export interface SendEmailInput {
  to: string;
  from: string;
  subject: string;
  body: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
  // Optional, forward-prep only (Additional Requirement #1) -- no active
  // branching on this value anywhere this session.
  category?: EmailCategory;
  // Deterministic per-logical-send identifier (e.g. the caller's own
  // email_send_log.id, generated once before any attempt is made) -- NOT
  // regenerated per retry. Providers that support a native idempotency
  // mechanism (Resend's own `Idempotency-Key` header) pass this same value
  // on every internal attempt, so a network timeout followed by the
  // provider's own retry-once can never result in the provider actually
  // transmitting the same email twice server-side. Provider-neutral concept
  // (most major providers support request-level idempotency keys).
  idempotencyKey?: string;
}

export interface SendEmailResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
  // How many real attempts this call made against the underlying provider
  // (1, or 2 when a transient failure triggered the locked retry-once
  // behavior). Provider-neutral concept (every provider can retry), additive
  // to the ARCHITECTURE LOCK's minimum {success, providerMessageId, error}
  // shape -- needed for email_send_log.attempt_count (Additional
  // Requirement #4).
  attemptCount?: number;
}

export interface DomainVerificationResult {
  // false when the provider couldn't meaningfully check at all (no
  // configured domain to check, or the check itself failed) -- distinct
  // from `verified: false`, which means a check DID run and the domain is
  // genuinely not verified.
  checked: boolean;
  verified: boolean;
  domain?: string;
}

// Module 33 Session 4B -- provider-neutral inbound-attachment metadata.
// Deliberately mirrors this repo's existing metadata-only attachment
// convention (StorageProvider never touches real bytes anywhere in this
// codebase, confirmed for Expense/PO-Negotiation/Shipment attachments
// alike) -- sizeBytes/mimeType/filename only, no content field. A future
// real StorageProvider implementation that actually needs bytes can fetch
// them itself via the provider's own attachment-download mechanism; that's
// out of scope for every attachment feature this repo has built so far,
// not a gap specific to this session.
export interface ReceivedEmailAttachment {
  id: string;
  filename: string | null;
  mimeType: string;
  sizeBytes: number;
}

export interface ReceivedEmail {
  emailId: string;
  from: string;
  to: string[];
  subject: string;
  text: string | null;
  attachments: ReceivedEmailAttachment[];
}
