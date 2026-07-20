export type NotificationCategory =
  | "SECURITY"
  | "BUSINESS_OPERATIONS"
  | "MARKETING"
  | "SYSTEM_ALERTS"
  | "TRANSACTIONAL";

export type NotificationChannel = "email" | "whatsapp";

export interface Notification {
  category: NotificationCategory;
  channel: NotificationChannel;
  to: string;
  subject?: string;
  body: string;
  metadata?: Record<string, unknown>;
}
