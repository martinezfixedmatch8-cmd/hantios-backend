// Module 33 Session 4A -- environment-driven, fail-soft EmailProvider
// selection (src/notifications/emailProviderRegistry.ts). The selection
// happens once, at module load, from env.RESEND_API_KEY -- so exercising
// both branches needs a fresh module load per scenario, via
// jest.resetModules() + a dynamic require (no existing jest.mock()
// precedent in this repo to follow here; this is the standard Jest
// technique for env-driven module-load-time behavior).
describe("EmailProvider selection -- RESEND_API_KEY present/absent", () => {
  const originalApiKey = process.env.RESEND_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
    jest.resetModules();
  });

  it("selects ResendEmailProvider when RESEND_API_KEY is set", () => {
    jest.resetModules();
    process.env.RESEND_API_KEY = "re_test_fake_key_for_selection_test";

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const registry = require("../src/notifications/emailProviderRegistry");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ResendEmailProvider } = require("../src/notifications/ResendEmailProvider");

    expect(registry.getEmailProviderName()).toBe("resend");
    expect(registry.getEmailProvider()).toBeInstanceOf(ResendEmailProvider);
  });

  it("falls back to ConsoleEmailProvider when RESEND_API_KEY is absent (fail-soft)", () => {
    jest.resetModules();
    delete process.env.RESEND_API_KEY;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const registry = require("../src/notifications/emailProviderRegistry");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ConsoleEmailProvider } = require("../src/notifications/ConsoleEmailProvider");

    expect(registry.getEmailProviderName()).toBe("console");
    expect(registry.getEmailProvider()).toBeInstanceOf(ConsoleEmailProvider);
  });

  it("setEmailProvider (the DI test seam) overrides the selected provider and its tracked name", () => {
    jest.resetModules();
    delete process.env.RESEND_API_KEY;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const registry = require("../src/notifications/emailProviderRegistry");
    const fake = { sendEmail: async () => ({ success: true }) };

    registry.setEmailProvider(fake, "spy");

    expect(registry.getEmailProvider()).toBe(fake);
    expect(registry.getEmailProviderName()).toBe("spy");
  });
});
