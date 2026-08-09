import type { EmailProvider } from "./EmailProvider";
import type { SendEmailInput, SendEmailResult } from "./emailTypes";
import { env } from "../lib/config";
import { generateId } from "../lib/ids";

// Fallback EmailProvider used when RESEND_API_KEY is unset (fail-soft
// environment-driven selection, src/notifications/registry.ts) -- mirrors
// ConsoleNotificationProvider/ConsoleStorageProvider's own dev-mode logging
// pattern exactly. Always "succeeds" (there is no real transmission to
// fail), so a missing API key never breaks the calling flow -- same
// reasoning as every other optional integration in this repo.
export class ConsoleEmailProvider implements EmailProvider {
  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const providerMessageId = `console-${generateId()}`;
    if (env.NODE_ENV !== "production") {
      console.log(`[email] ${input.from} -> ${input.to}`);
      console.log(`  subject: ${input.subject}`);
      console.log(`  body: ${input.body}`);
    } else {
      console.log(`[email] would send to ${input.to} (RESEND_API_KEY not configured)`);
    }
    return { success: true, providerMessageId, attemptCount: 1 };
  }
}
