import type {
  DomainVerificationResult,
  EmailAttachment,
  EmailCategory,
  ReceivedEmail,
  ReceivedEmailAttachment,
  SendEmailInput,
  SendEmailResult,
} from "./emailTypes";

export type { DomainVerificationResult, EmailAttachment, EmailCategory, ReceivedEmail, ReceivedEmailAttachment, SendEmailInput, SendEmailResult };

// Module 33 Session 4A -- Real Email Sending (ARCHITECTURE LOCK).
//
// Provider-neutral interface only -- exposes exactly the concepts common to
// every major provider (to/from/replyTo/subject/body/attachments/headers),
// nothing Resend-specific (no audience/broadcast/tag concepts). This is
// what makes adding AWS SES/Postmark/SendGrid/Mailgun later a pure addition
// (one new file + one registry line), never a rewrite of anything that
// calls sendEmail.
//
// Hard rule, enforced by tests/emailArchitectureLock.unit.test.ts: NO file
// outside a concrete EmailProvider implementation (ResendEmailProvider.ts
// today) may ever `import { Resend }` or any other provider SDK. Every
// caller -- NotificationProvider's email-channel logic included -- talks to
// this interface only, never to a concrete SDK client directly.
export interface EmailProvider {
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;

  // Optional -- "is our sending domain verified" is a concept common to
  // every major provider (SES/Postmark/SendGrid/Mailgun all have one), not
  // Resend-specific, so it belongs on the shared interface rather than
  // leaking through a type cast. Optional because a stub/fallback provider
  // (ConsoleEmailProvider) has no real domain to check. Used only by the
  // non-blocking startup warning (src/lib/emailDomainCheck.ts) -- never
  // called from a request path.
  checkDomainVerification?(): Promise<DomainVerificationResult>;

  // Module 33 Session 4B -- fetches the full body/attachment-metadata of a
  // previously-received inbound email, given the provider's own opaque
  // email id. Optional, same reasoning as checkDomainVerification -- inbound
  // receiving is a real capability most major providers offer in some form
  // (SES, Postmark, Mailgun, SendGrid all support inbound parsing), but a
  // stub/fallback provider has nothing real to fetch. Returns null when the
  // provider can't retrieve it (never throws) -- the inbound webhook
  // handler (src/services/resendInboundWebhook.service.ts) treats a null
  // result as a parse failure and quarantines the event rather than
  // crashing.
  getReceivedEmail?(emailId: string): Promise<ReceivedEmail | null>;
}
