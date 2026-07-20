import type { NotificationProvider } from "../../src/notifications/NotificationProvider";
import type { Notification } from "../../src/notifications/types";

export class SpyNotificationProvider implements NotificationProvider {
  sent: Notification[] = [];

  async send(notification: Notification): Promise<void> {
    this.sent.push(notification);
  }
}
