import { renderEmailTemplate } from "../src/notifications/EmailTemplateRenderer";

describe("EmailTemplateRenderer", () => {
  it("renders email_verification with the exact pre-existing content, independent of any EmailProvider", () => {
    const { subject, body } = renderEmailTemplate("email_verification", {
      name: "Test Owner",
      verifyUrl: "http://localhost:3000/verify-email/abc123",
    });

    expect(subject).toBe("Verify your HantiOS email address");
    expect(body).toBe("Hi Test Owner, please verify your email address: http://localhost:3000/verify-email/abc123");
  });

  it("renders staff_invite_created with the exact pre-existing content", () => {
    const { subject, body } = renderEmailTemplate("staff_invite_created", {
      businessName: "Acme Traders",
      inviterName: "Jane Owner",
      role: "manager",
      acceptUrl: "http://localhost:3000/invite/tok123",
    });

    expect(subject).toBe("You've been invited to join Acme Traders on HantiOS");
    expect(body).toBe("Jane Owner invited you to join Acme Traders as a manager. Accept your invitation: http://localhost:3000/invite/tok123");
  });

  it("renders staff_invite_accepted with the exact pre-existing content", () => {
    const { subject, body } = renderEmailTemplate("staff_invite_accepted", { businessName: "Acme Traders" });

    expect(subject).toBe("Your Acme Traders account is active");
    expect(body).toBe("Your account has been activated. You can now log in with your email and password.");
  });

  it("renders po_negotiation_secure_link with the supplied variables", () => {
    const { subject, body } = renderEmailTemplate("po_negotiation_secure_link", {
      businessName: "Acme Traders",
      poNumber: "PO-000001",
      secureLinkUrl: "http://localhost:3000/po/tok456",
    });

    expect(subject).toBe("Acme Traders sent you Purchase Order PO-000001 for review");
    expect(body).toContain("http://localhost:3000/po/tok456");
    expect(body).toContain("expires in 30 days");
  });

  it("throws on an unknown template key rather than silently returning empty content", () => {
    expect(() => renderEmailTemplate("nonexistent_template" as never, {})).toThrow("Unknown email template");
  });
});
