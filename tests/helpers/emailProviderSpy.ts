import type { EmailProvider } from "../../src/notifications/EmailProvider";
import type { DomainVerificationResult, SendEmailInput, SendEmailResult } from "../../src/notifications/emailTypes";

// Same DI-seam test-double pattern as SpyNotificationProvider/
// SpyStorageProvider -- swapped in via setEmailProvider, never jest.mock().
export class SpyEmailProvider implements EmailProvider {
  sent: SendEmailInput[] = [];
  // When set, the next N sendEmail calls return this instead of a real
  // success -- lets a test simulate a failing EmailProvider without
  // touching ResendEmailProvider's own retry logic (that's covered
  // separately, at the ResendEmailProvider unit-test level).
  nextResult: SendEmailResult | null = null;

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
}
