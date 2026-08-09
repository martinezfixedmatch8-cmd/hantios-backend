import { env } from "./config";
import { getEmailProvider, getEmailProviderName } from "../notifications/registry";

// Module 33 Session 4A -- domain verification startup check. Runs once on
// app boot (src/index.ts), logs a clear warning when something looks
// unconfigured/unverified, and NEVER blocks startup -- explicitly locked:
// "log a clear warning if not, but never block app startup over this."
//
// Deliberately calls EmailProvider.checkDomainVerification() (an optional
// interface method, see EmailProvider.ts) rather than importing Resend
// directly here -- this file is not a concrete EmailProvider implementation,
// so it must never `import { Resend }` itself (ARCHITECTURE LOCK).
export async function checkEmailDomainVerification(): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.warn(
      "[email] RESEND_API_KEY is not set -- real email sending is disabled, falling back to console logging (ConsoleEmailProvider). This is fine for development; set RESEND_API_KEY before going to production."
    );
    return;
  }

  if (!env.RESEND_FROM_EMAIL) {
    console.warn(
      "[email] RESEND_API_KEY is set but RESEND_FROM_EMAIL is not -- emails will send from a default noreply@hantios.com address that may not be on a verified domain. Set RESEND_FROM_EMAIL to your verified sending address."
    );
    return;
  }

  const provider = getEmailProvider();
  if (!provider.checkDomainVerification) {
    return;
  }

  try {
    const result = await provider.checkDomainVerification();
    if (!result.checked) {
      console.warn(
        `[email] could not confirm domain verification status for "${result.domain ?? env.RESEND_FROM_EMAIL}" via the ${getEmailProviderName()} provider -- check your Resend dashboard directly.`
      );
      return;
    }
    if (!result.verified) {
      console.warn(
        `[email] sending domain "${result.domain}" is NOT verified in Resend yet -- emails may fail to send or land in spam until DNS verification completes. See https://resend.com/domains.`
      );
      return;
    }
    console.log(`[email] sending domain "${result.domain}" is verified in Resend.`);
  } catch (err) {
    // Best-effort only -- never let a domain-check failure affect startup.
    console.warn("[email] domain verification check failed unexpectedly (non-blocking):", err);
  }
}
