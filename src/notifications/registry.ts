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

// Module 33 Session 4A -- EmailProvider selection lives in its own file
// (emailProviderRegistry.ts) to avoid a circular import (this file
// constructs ConsoleNotificationProvider, whose email-channel path needs to
// call back into the EmailProvider registry -- see that file's own comment
// for the full reasoning). Re-exported here so callers can still import
// everything from "./registry" as one entry point.
export { getEmailProvider, getEmailProviderName, setEmailProvider } from "./emailProviderRegistry";
