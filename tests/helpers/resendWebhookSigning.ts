import { Webhook } from "svix";

// Module 33 Session 4B -- builds a REAL, authentically-signed webhook
// request body + headers using svix's own real Webhook.sign() (the same
// library/algorithm Resend's own webhook delivery infrastructure uses),
// against the test secret configured in this environment's own .env
// (RESEND_WEBHOOK_SECRET). This exercises the actual verification code
// path for real -- not a bypass -- the strongest verification achievable
// without a live, publicly-reachable Resend-configured webhook endpoint
// (see CLAUDE.md's own Session 4B write-up for why that's not achievable
// in this sandboxed environment).
export function signWebhookPayload(payload: unknown, secret: string): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date();
  const webhook = new Webhook(secret);
  const signature = webhook.sign(msgId, timestamp, body);
  return {
    body,
    headers: {
      "svix-id": msgId,
      "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
      "svix-signature": signature,
    },
  };
}

export function emailReceivedPayload(overrides: {
  emailId: string;
  from: string;
  to: string[];
  subject?: string;
  attachments?: { id: string; filename: string | null; content_type: string; content_disposition?: string | null; content_id?: string | null }[];
}) {
  return {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: overrides.emailId,
      created_at: new Date().toISOString(),
      from: overrides.from,
      to: overrides.to,
      bcc: [],
      cc: [],
      received_for: overrides.to,
      message_id: `<${overrides.emailId}@mail.example.test>`,
      subject: overrides.subject ?? "Re: Purchase Order",
      attachments: overrides.attachments ?? [],
    },
  };
}
