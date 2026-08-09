import type { EmailProvider } from "./EmailProvider";
import { ConsoleEmailProvider } from "./ConsoleEmailProvider";
import { ResendEmailProvider } from "./ResendEmailProvider";
import { env } from "../lib/config";

// Module 33 Session 4A -- environment-driven, fail-soft EmailProvider
// selection: RESEND_API_KEY present -> ResendEmailProvider (real sending);
// absent -> ConsoleEmailProvider (fail-soft fallback, same pattern as this
// repo's other optional integrations, e.g. Google auth/Turnstile).
//
// Deliberately its own file, not defined directly in registry.ts: registry.ts
// constructs ConsoleNotificationProvider, whose email-channel path
// (src/notifications/emailDelivery.ts) needs to call back into this
// EmailProvider registry -- putting these functions in registry.ts itself
// would create registry.ts -> ConsoleNotificationProvider.ts ->
// emailDelivery.ts -> registry.ts, a real circular import. registry.ts
// re-exports everything from here, so external callers (services, tests)
// still import it from "./registry" exactly as if it lived there directly.
let emailProvider: EmailProvider = env.RESEND_API_KEY
  ? new ResendEmailProvider(env.RESEND_API_KEY, { fromEmail: env.RESEND_FROM_EMAIL })
  : new ConsoleEmailProvider();

// Which implementation is active, for email_send_log.provider -- a plain
// tracked name rather than reflection on the instance (e.g. constructor.name),
// which would be fragile and wouldn't have a sensible value once a test
// swaps in a spy.
let emailProviderName: string = env.RESEND_API_KEY ? "resend" : "console";

export function getEmailProvider(): EmailProvider {
  return emailProvider;
}

export function getEmailProviderName(): string {
  return emailProviderName;
}

// Dependency-injection seam so tests can swap in a spy instead of depending
// on console output or a real Resend call to assert an email was sent.
export function setEmailProvider(next: EmailProvider, name = "test"): void {
  emailProvider = next;
  emailProviderName = name;
}
