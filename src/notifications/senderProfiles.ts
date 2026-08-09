import type { SenderProfile } from "@prisma/client";
import { env } from "../lib/config";

export type { SenderProfile };

// The 13-address sender-identity system (LOCKED, Additional Requirement #2).
// A simple constant map, not env-driven per-profile -- 13 new env vars for
// addresses that mostly have no real call site yet would be over-config for
// what this session actually needs; adding one later (a real Sales/Legal/HR
// module) is a one-line change here, never a redesign.
//
// Only SECURITY/NOTIFICATIONS/NOREPLY get a real call site wired this
// session (src/notifications/emailDelivery.ts + the 4 call sites it
// serves) -- BILLING/SUPPORT and the rest exist as configured addresses
// ready for modules that don't exist yet, per the locked instruction not to
// build speculative call-site logic for them.
const SENDER_PROFILE_ADDRESSES: Record<SenderProfile, string> = {
  SECURITY: "security@hantios.com",
  NOTIFICATIONS: "notifications@hantios.com",
  BILLING: "billing@hantios.com",
  SUPPORT: "support@hantios.com",
  SALES: "sales@hantios.com",
  MARKETING: "marketing@hantios.com",
  CAREERS: "careers@hantios.com",
  HR: "hr@hantios.com",
  PARTNERS: "partners@hantios.com",
  LEGAL: "legal@hantios.com",
  PRIVACY: "privacy@hantios.com",
  COMPLIANCE: "compliance@hantios.com",
  // RESEND_FROM_EMAIL overrides the NOREPLY address specifically when set --
  // reconciles the base spec's own literal "RESEND_FROM_EMAIL" ask (a single
  // configured sender/verification address) with the fuller 13-address
  // system added on review, without requiring 13 separate env vars.
  NOREPLY: env.RESEND_FROM_EMAIL ?? "noreply@hantios.com",
};

export function resolveSenderAddress(profile: SenderProfile): string {
  return SENDER_PROFILE_ADDRESSES[profile];
}

// Config-level default reply-to (Additional Requirement #2) -- used
// whenever a send doesn't specify its own replyTo.
export const DEFAULT_REPLY_TO = SENDER_PROFILE_ADDRESSES.SUPPORT;
