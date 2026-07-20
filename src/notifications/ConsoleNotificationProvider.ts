import type { NotificationProvider } from "./NotificationProvider";
import type { Notification } from "./types";
import { env } from "../lib/config";

function redactRecipient(to: string): string {
  const [localPart, domain] = to.split("@");
  if (!domain) return "***";
  return `${localPart[0] ?? "*"}***@${domain}`;
}

// Stub provider: real email/WhatsApp sending isn't wired up yet (blocked on Business
// Verification for WhatsApp, no real email sender chosen yet). This is the only
// delivery mechanism that exists right now, so in non-production environments it
// logs the full content -- including links/tokens -- so the flow is actually usable
// end-to-end during development and testing. In production it logs only a redacted
// summary, never the body, to avoid putting invite tokens or other sensitive content
// into server logs.
export class ConsoleNotificationProvider implements NotificationProvider {
  async send(notification: Notification): Promise<void> {
    if (env.NODE_ENV === "production") {
      console.log(
        `[notification] would send ${notification.category}/${notification.channel} to ${redactRecipient(notification.to)}`
      );
      return;
    }

    console.log(`[notification] ${notification.category}/${notification.channel} -> ${notification.to}`);
    if (notification.subject) console.log(`  subject: ${notification.subject}`);
    console.log(`  body: ${notification.body}`);
  }
}
