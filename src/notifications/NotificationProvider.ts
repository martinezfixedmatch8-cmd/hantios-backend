import type { Notification } from "./types";

export interface NotificationProvider {
  send(notification: Notification): Promise<void>;
  // Batch 8 Session A (HNT-DELIV-001) -- optional capability, mirroring
  // EmailProvider's own checkDomainVerification? precedent. A real WhatsApp
  // Business API provider implementing this lets the receipt-delivery
  // recovery worker reconcile a stuck "sending" row against the provider's
  // own truth; ConsoleNotificationProvider does NOT implement it (there is
  // nothing real to reconcile against), so the recovery worker's own
  // capability check comes back false and every stuck row is instead
  // marked "unknown" for manual review -- never guessed as "failed."
  checkDeliveryStatus?(providerRef: string): Promise<{ status: "delivered" | "failed" | "unknown" }>;
}
