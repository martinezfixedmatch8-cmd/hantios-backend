import type { NotificationCategory } from "@prisma/client";
import type { SenderProfile } from "./senderProfiles";
import type { EmailAttachment } from "./emailTypes";

// Module 33 Session 4A -- promoted to a real Prisma enum now that
// email_send_log is the first thing that ever needs to persist it (matching
// Low Stock Alert's own "no DB enum until something actually persists it"
// precedent). Re-exported here, unchanged in shape/casing, so every one of
// the 10+ pre-existing call sites using a literal like `category: "SECURITY"`
// keeps compiling with zero changes.
export type { NotificationCategory };

export type NotificationChannel = "email" | "whatsapp";

export interface Notification {
  category: NotificationCategory;
  channel: NotificationChannel;
  to: string;
  // Required -- every real call site already has one in scope (this is a
  // multi-tenant SaaS), and email_send_log needs it on every logged row.
  businessId: string;
  subject?: string;
  body: string;
  // Email-channel only, ignored by "whatsapp" sends. senderProfile defaults
  // to NOREPLY when omitted (src/notifications/emailDelivery.ts); replyTo
  // defaults to DEFAULT_REPLY_TO (support@hantios.com) when omitted.
  senderProfile?: SenderProfile;
  replyTo?: string;
  attachments?: EmailAttachment[];
  metadata?: Record<string, unknown>;
}
