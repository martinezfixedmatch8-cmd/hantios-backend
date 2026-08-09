import { Resend } from "resend";
import type { EmailProvider } from "./EmailProvider";
import type { DomainVerificationResult, EmailAttachment, SendEmailInput, SendEmailResult } from "./emailTypes";

// The ONLY file in this codebase allowed to `import { Resend }` (or any
// other email-provider SDK) -- ARCHITECTURE LOCK, enforced by
// tests/emailArchitectureLock.unit.test.ts. Every caller, including
// NotificationProvider's own email-channel logic, talks to the
// EmailProvider interface only.

// The minimal shape of Resend's client this provider actually depends on.
// Confirmed via the installed SDK's own type defs (node_modules/resend):
// emails.send() never throws -- it always resolves {data, error}, where a
// genuine network/transport failure, a 5xx, and a 429 rate-limit all
// surface as `error.statusCode`/`error.name`, never as a thrown exception.
// Typing against this narrow shape (rather than the SDK's own exported
// Resend class) is what lets a test inject a fake client without needing
// the real SDK's full surface -- this repo's established DI-seam pattern
// (FakeGoogleAuthProvider) applied one level deeper, since retry logic
// needs to be unit-tested without hitting the network.
export interface ResendLikeClient {
  emails: {
    send(payload: ResendSendPayload): Promise<ResendSendResponse>;
  };
  // Optional -- only used by checkDomainVerification (the non-blocking
  // startup check), never by sendEmail. Narrowed the same way emails.send
  // is: just enough shape for this provider's own use, so a test can inject
  // a fake without needing the real SDK's full Domains class.
  domains?: {
    list(): Promise<ResendListDomainsResponse>;
  };
}

export interface ResendListDomainsResponse {
  data: { data: { name: string; status: string }[] } | null;
  error: { message: string; statusCode: number | null; name: string } | null;
}

export interface ResendSendPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer | string; contentType?: string }[];
}

export interface ResendSendResponse {
  data: { id: string } | null;
  error: { message: string; statusCode: number | null; name: string } | null;
}

// Retry-once classification (LOCKED): network errors (no HTTP response at
// all -- statusCode null), 5xx, and 429 (rate-limited) are all transient
// and get exactly one immediate retry. Everything else (validation errors,
// invalid_api_key, invalid_from_address, quota-exceeded, ...) is a
// definite, ongoing failure that a retry cannot fix -- fail immediately, no
// retry, not a queue, not exponential backoff (Session 7 territory).
function isTransientFailure(statusCode: number | null): boolean {
  if (statusCode === null) return true;
  if (statusCode === 429) return true;
  return statusCode >= 500 && statusCode < 600;
}

function toResendAttachments(attachments?: EmailAttachment[]): ResendSendPayload["attachments"] {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    content: attachment.content,
    contentType: attachment.mimeType,
  }));
}

// Handles both a bare address ("noreply@hantios.com") and Resend's own
// "Display Name <addr@domain.com>" format.
function extractDomain(fromAddress: string): string | null {
  const match = fromAddress.match(/([^\s<>@]+)@([^\s<>@]+)>?\s*$/);
  return match ? match[2] : null;
}

function toResendPayload(input: SendEmailInput): ResendSendPayload {
  return {
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: input.body,
    replyTo: input.replyTo,
    headers: input.headers,
    attachments: toResendAttachments(input.attachments),
  };
}

interface AttemptOutcome {
  success: boolean;
  providerMessageId?: string;
  error?: string;
  statusCode: number | null;
}

export interface ResendEmailProviderOptions {
  // Constructor-injectable so unit tests can simulate transient/permanent
  // failures without hitting Resend's real network -- defaults to a real
  // Resend client for actual production use.
  client?: ResendLikeClient;
  // Explicit dependency rather than an internal read of the global `env`
  // singleton -- keeps checkDomainVerification's domain-matching logic
  // testable via constructor injection (the same reason `apiKey` itself is
  // a constructor param, not read from env internally). The real
  // production value (env.RESEND_FROM_EMAIL) is passed in once, by the one
  // real call site that constructs this provider (emailProviderRegistry.ts).
  fromEmail?: string;
}

export class ResendEmailProvider implements EmailProvider {
  private readonly client: ResendLikeClient;
  private readonly fromEmail?: string;

  constructor(apiKey: string, options: ResendEmailProviderOptions = {}) {
    this.client = options.client ?? new Resend(apiKey);
    this.fromEmail = options.fromEmail;
  }

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const payload = toResendPayload(input);

    const first = await this.attemptSend(payload);
    if (first.success) {
      return { success: true, providerMessageId: first.providerMessageId, attemptCount: 1 };
    }

    if (!isTransientFailure(first.statusCode)) {
      return { success: false, error: first.error, attemptCount: 1 };
    }

    // Exactly one immediate retry on a transient failure -- never more.
    const second = await this.attemptSend(payload);
    if (second.success) {
      return { success: true, providerMessageId: second.providerMessageId, attemptCount: 2 };
    }
    return { success: false, error: second.error, attemptCount: 2 };
  }

  // Non-blocking startup check only (src/lib/emailDomainCheck.ts) -- never
  // called from a request path. Best-effort: any failure to determine
  // verification status is reported as `checked: false`, never thrown.
  async checkDomainVerification(): Promise<DomainVerificationResult> {
    if (!this.fromEmail) return { checked: false, verified: false };

    const domain = extractDomain(this.fromEmail);
    if (!domain) return { checked: false, verified: false };

    if (!this.client.domains?.list) return { checked: false, verified: false, domain };

    try {
      const result = await this.client.domains.list();
      if (result.error || !result.data) return { checked: false, verified: false, domain };
      const match = result.data.data.find((d) => d.name === domain);
      return { checked: true, verified: match?.status === "verified", domain };
    } catch {
      return { checked: false, verified: false, domain };
    }
  }

  private async attemptSend(payload: ResendSendPayload): Promise<AttemptOutcome> {
    try {
      const result = await this.client.emails.send(payload);
      if (!result.error) {
        return { success: true, providerMessageId: result.data?.id, statusCode: null };
      }
      return {
        success: false,
        error: `${result.error.name}: ${result.error.message}`,
        statusCode: result.error.statusCode,
      };
    } catch (err) {
      // Defensive: the real SDK never throws for emails.send() (confirmed
      // via its own source), but a failure must never cascade into the
      // calling transaction regardless -- treat anything unexpected as a
      // transient transport failure (statusCode null) so it still gets the
      // one retry.
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown email send failure",
        statusCode: null,
      };
    }
  }
}
