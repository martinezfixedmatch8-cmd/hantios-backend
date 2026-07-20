import type { NotificationProvider } from "./NotificationProvider";
import { ConsoleNotificationProvider } from "./ConsoleNotificationProvider";

let provider: NotificationProvider = new ConsoleNotificationProvider();

export function getNotificationProvider(): NotificationProvider {
  return provider;
}

// Dependency-injection seam so tests can swap in a spy/mock instead of
// depending on console output to assert a notification was sent.
export function setNotificationProvider(next: NotificationProvider): void {
  provider = next;
}
