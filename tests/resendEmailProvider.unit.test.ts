import { ResendEmailProvider } from "../src/notifications/ResendEmailProvider";
import { FakeResendClient, resendError, resendSuccess } from "./helpers/fakeResendClient";
import type { SendEmailInput } from "../src/notifications/emailTypes";

const baseInput: SendEmailInput = {
  to: "recipient@example.test",
  from: "noreply@hantios.com",
  subject: "Test subject",
  body: "Test body",
};

describe("ResendEmailProvider -- retry-once on transient failure", () => {
  it("succeeds on the first attempt with no retry", async () => {
    const client = new FakeResendClient([resendSuccess("id-1")]);
    const provider = new ResendEmailProvider("test-key", { client });

    const result = await provider.sendEmail(baseInput);

    expect(result).toEqual({ success: true, providerMessageId: "id-1", attemptCount: 1 });
    expect(client.calls).toHaveLength(1);
  });

  it("retries exactly once on a 429 (rate-limited) and succeeds on the retry", async () => {
    const client = new FakeResendClient([resendError(429, "rate_limit_exceeded"), resendSuccess("id-retry")]);
    const provider = new ResendEmailProvider("test-key", { client });

    const result = await provider.sendEmail(baseInput);

    expect(result).toEqual({ success: true, providerMessageId: "id-retry", attemptCount: 2 });
    expect(client.calls).toHaveLength(2);
  });

  it("retries exactly once on a 500 and fails cleanly if the retry also fails", async () => {
    const client = new FakeResendClient([resendError(500, "internal_server_error"), resendError(503, "internal_server_error")]);
    const provider = new ResendEmailProvider("test-key", { client });

    const result = await provider.sendEmail(baseInput);

    expect(result.success).toBe(false);
    expect(result.attemptCount).toBe(2);
    expect(client.calls).toHaveLength(2);
  });

  it("retries exactly once on a network/transport failure (statusCode null)", async () => {
    const client = new FakeResendClient([resendError(null, "application_error", "Unable to fetch data."), resendSuccess("id-network-retry")]);
    const provider = new ResendEmailProvider("test-key", { client });

    const result = await provider.sendEmail(baseInput);

    expect(result).toEqual({ success: true, providerMessageId: "id-network-retry", attemptCount: 2 });
    expect(client.calls).toHaveLength(2);
  });

  it("does NOT retry a non-transient (permanent) failure, e.g. an invalid API key", async () => {
    const client = new FakeResendClient([resendError(401, "invalid_api_key"), resendSuccess("would-never-be-reached")]);
    const provider = new ResendEmailProvider("test-key", { client });

    const result = await provider.sendEmail(baseInput);

    expect(result.success).toBe(false);
    expect(result.attemptCount).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(result.error).toContain("invalid_api_key");
  });

  it("does NOT retry a validation error (400)", async () => {
    const client = new FakeResendClient([resendError(400, "validation_error")]);
    const provider = new ResendEmailProvider("test-key", { client });

    const result = await provider.sendEmail(baseInput);

    expect(result.success).toBe(false);
    expect(result.attemptCount).toBe(1);
    expect(client.calls).toHaveLength(1);
  });

  it("never throws even if the underlying client rejects unexpectedly -- treats it as a retryable transient failure", async () => {
    const client = new FakeResendClient([resendSuccess("unused")]);
    client.emails.send = async () => {
      throw new Error("unexpected client crash");
    };
    const provider = new ResendEmailProvider("test-key", { client });

    await expect(provider.sendEmail(baseInput)).resolves.toEqual(
      expect.objectContaining({ success: false, attemptCount: 2 })
    );
  });

  it("reuses the SAME idempotency key across the internal retry -- never regenerated per attempt", async () => {
    const client = new FakeResendClient([resendError(429, "rate_limit_exceeded"), resendSuccess("id-retry")]);
    const provider = new ResendEmailProvider("test-key", { client });

    const result = await provider.sendEmail({ ...baseInput, idempotencyKey: "logical-send-abc123" });

    expect(result.attemptCount).toBe(2);
    expect(client.callOptions).toHaveLength(2);
    expect(client.callOptions[0]).toEqual({ idempotencyKey: "logical-send-abc123" });
    expect(client.callOptions[1]).toEqual({ idempotencyKey: "logical-send-abc123" });
    expect(client.callOptions[0]).toEqual(client.callOptions[1]);
  });

  it("passes no idempotency option at all when the caller didn't supply one (never a client-invented random value)", async () => {
    const client = new FakeResendClient([resendSuccess("id-no-key")]);
    const provider = new ResendEmailProvider("test-key", { client });

    await provider.sendEmail(baseInput);

    expect(client.callOptions[0]).toBeUndefined();
  });

  it("maps EmailAttachment.mimeType to Resend's own contentType field internally, invisible to the caller", async () => {
    const client = new FakeResendClient([resendSuccess("id-attach")]);
    const provider = new ResendEmailProvider("test-key", { client });

    await provider.sendEmail({
      ...baseInput,
      attachments: [{ filename: "invoice.pdf", content: "base64content", mimeType: "application/pdf" }],
    });

    expect(client.calls[0].attachments).toEqual([
      { filename: "invoice.pdf", content: "base64content", contentType: "application/pdf" },
    ]);
  });
});

describe("ResendEmailProvider -- checkDomainVerification", () => {
  // fromEmail is constructor-injected (not read from the global `env`
  // singleton internally) specifically so this is deterministically
  // testable -- see ResendEmailProviderOptions's own comment for why.
  it("reports checked:true, verified:true when the from-domain is in Resend's verified domain list", async () => {
    const client = new FakeResendClient([resendSuccess()]);
    client.domainsResponse = { data: { data: [{ name: "hantios.com", status: "verified" }] }, error: null };
    const provider = new ResendEmailProvider("test-key", { client, fromEmail: "noreply@hantios.com" });

    const result = await provider.checkDomainVerification();

    expect(result).toEqual({ checked: true, verified: true, domain: "hantios.com" });
  });

  it("reports checked:true, verified:false when the domain exists but isn't verified yet", async () => {
    const client = new FakeResendClient([resendSuccess()]);
    client.domainsResponse = { data: { data: [{ name: "hantios.com", status: "pending" }] }, error: null };
    const provider = new ResendEmailProvider("test-key", { client, fromEmail: "noreply@hantios.com" });

    const result = await provider.checkDomainVerification();

    expect(result).toEqual({ checked: true, verified: false, domain: "hantios.com" });
  });

  it("extracts the domain correctly from Resend's 'Display Name <addr@domain.com>' format", async () => {
    const client = new FakeResendClient([resendSuccess()]);
    client.domainsResponse = { data: { data: [{ name: "hantios.com", status: "verified" }] }, error: null };
    const provider = new ResendEmailProvider("test-key", { client, fromEmail: "HantiOS <noreply@hantios.com>" });

    const result = await provider.checkDomainVerification();

    expect(result.domain).toBe("hantios.com");
    expect(result.verified).toBe(true);
  });

  it("reports checked:false when no fromEmail is configured", async () => {
    const client = new FakeResendClient([resendSuccess()]);
    const provider = new ResendEmailProvider("test-key", { client });

    const result = await provider.checkDomainVerification();

    expect(result).toEqual({ checked: false, verified: false });
  });

  it("reports checked:false when the client has no domains.list capability", async () => {
    const client = new FakeResendClient([resendSuccess()]);
    delete (client as { domains?: unknown }).domains;
    const provider = new ResendEmailProvider("test-key", { client, fromEmail: "noreply@hantios.com" });

    const result = await provider.checkDomainVerification();
    expect(result.checked).toBe(false);
  });

  it("reports checked:false (never throws) when the domains.list call itself errors", async () => {
    const client = new FakeResendClient([resendSuccess()]);
    client.domainsResponse = { data: null, error: { message: "unauthorized", statusCode: 401, name: "invalid_api_key" } };
    const provider = new ResendEmailProvider("test-key", { client, fromEmail: "noreply@hantios.com" });

    const result = await provider.checkDomainVerification();
    expect(result.checked).toBe(false);
  });
});
