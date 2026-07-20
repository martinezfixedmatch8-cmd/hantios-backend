import type { Notification } from "./types";

export interface NotificationProvider {
  send(notification: Notification): Promise<void>;
}
