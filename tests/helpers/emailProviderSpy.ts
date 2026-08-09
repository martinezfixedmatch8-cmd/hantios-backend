import type { EmailProvider } from "../../src/notifications/EmailProvider";
import type { DomainVerificationResult, ReceivedEmail, SendEmailInput, SendEmailResult } from "../../src/notifications/emailTypes";

// Same DI-seam test-double pattern as SpyNotificationProvider/
// SpyStorageProvider -- swapped in via setEmailProvider, never jest.mock().
export class SpyEmailProvider implements EmailProvider {
  sent: SendEmailInput[] = [];
  // When set, the next N sendEmail calls return this instead of a real
  // success -- lets a test simulate a failing EmailProvider without
  // touching ResendEmailProvider's own retry logic (that's covered
  // separately, at the ResendEmailProvider unit-test level).
  nextResult: SendEmailResult | null = null;
  // Module 33 Session 4B -- programmed per-emailId, since the inbound
  // webhook flow calls getReceivedEmail(emailId) to fetch full body content
  // the webhook payload itself never carries. A missing entry returns null,
  // matching the real ResendEmailProvider's own "can't fetch it" behavior.
  receivedEmails: Map<string, ReceivedEmail> = new Map();

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    this.sent.push(input);
    if (this.nextResult) {
      return this.nextResult;
    }
    return { success: true, providerMessageId: `spy-${this.sent.length}`, attemptCount: 1 };
  }

  async checkDomainVerification(): Promise<DomainVerificationResult> {
    return { checked: true, verified: true, domain: "example.test" };
  }

  async getReceivedEmail(emailId: string): Promise<ReceivedEmail | null> {
    return this.receivedEmails.get(emailId) ?? null;
  }
}
