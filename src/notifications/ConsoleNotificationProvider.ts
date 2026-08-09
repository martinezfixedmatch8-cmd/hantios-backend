import type { NotificationProvider } from "./NotificationProvider";
import type { Notification } from "./types";
import { env } from "../lib/config";
import { sendEmailNotification } from "./emailDelivery";

function redactRecipient(to: string): string {
  const [localPart, domain] = to.split("@");
  if (!domain) return "***";
  return `${localPart[0] ?? "*"}***@${domain}`;
}

// Module 33 Session 4A -- the email channel now really sends, via
// sendEmailNotification (src/notifications/emailDelivery.ts), which
// resolves a SenderProfile, calls the registered EmailProvider (Resend when
// RESEND_API_KEY is set, Console fallback otherwise -- fail-soft, see
// emailProviderRegistry.ts), and logs the outcome to email_send_log. This
// is "NotificationProvider's email-channel logic" the architecture lock
// describes -- ConsoleNotificationProvider stays the one and only
// NotificationProvider implementation, it just now has real behavior for
// one of its two channels.
//
// The whatsapp channel is untouched: real WhatsApp Business API sending is
// still blocked on Meta Business Verification (a separate, unrelated
// blocker), so it keeps using the same console-logging stub as before --
// in non-production environments it logs the full content (including
// links/codes) so the flow is usable end-to-end during development and
// testing; in production it logs only a redacted summary, never the body.
export class ConsoleNotificationProvider implements NotificationProvider {
  async send(notification: Notification): Promise<void> {
    if (notification.channel === "email") {
      await sendEmailNotification(notification);
      return;
    }

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
