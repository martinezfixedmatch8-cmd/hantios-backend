// Module 33 Session 4A -- EmailTemplateRenderer, a genuinely separate
// concern from both NotificationProvider and EmailProvider: a calling
// service decides WHAT to send and WHEN (it invokes renderEmailTemplate,
// then calls getNotificationProvider().send()); this module builds the
// actual subject/body content; EmailProvider (via NotificationProvider's
// email-channel logic, src/notifications/emailDelivery.ts) only knows HOW
// to transmit whatever it's handed. Three genuinely independent files --
// a future provider swap or a future template redesign each touch exactly
// one of them.
//
// Kept simple this session, per the locked instruction: content is copied
// verbatim from the 3 pre-existing call sites' own inline strings (not
// redesigned), plus one new template for PO Negotiation's secure-link email
// (which never sent anything before this session -- there was no existing
// content to reuse there). English-only -- unlike src/lib/messageTemplates.ts
// (Low Stock Alert's WhatsApp registry), this is not a multi-language
// system; nothing in the locked scope asked for one, and building one
// speculatively here would be exactly the "template design system" this
// session was explicitly told not to build.

type TemplateVariables = Record<string, string>;
type TemplateRenderer = (variables: TemplateVariables) => { subject: string; body: string };

const templates = {
  // Verbatim from src/services/emailVerification.service.ts's own
  // pre-existing inline strings.
  email_verification: (v: TemplateVariables) => ({
    subject: "Verify your HantiOS email address",
    body: `Hi ${v.name}, please verify your email address: ${v.verifyUrl}`,
  }),
  // Verbatim from src/services/staffInvite.service.ts's own pre-existing
  // inline strings (invite-created send).
  staff_invite_created: (v: TemplateVariables) => ({
    subject: `You've been invited to join ${v.businessName} on HantiOS`,
    body: `${v.inviterName} invited you to join ${v.businessName} as a ${v.role}. Accept your invitation: ${v.acceptUrl}`,
  }),
  // Verbatim from src/services/staffInvite.service.ts's own pre-existing
  // inline strings (invite-accepted send).
  staff_invite_accepted: (v: TemplateVariables) => ({
    subject: `Your ${v.businessName} account is active`,
    body: `Your account has been activated. You can now log in with your email and password.`,
  }),
  // New -- PO Negotiation's secure-link generation never sent an email
  // before this session (confirmed in Phase 0: it only returned the URL in
  // the response body for the owner to relay manually), so there is no
  // pre-existing content to reuse here. Written to match the tone of the
  // 3 templates above.
  po_negotiation_secure_link: (v: TemplateVariables) => ({
    subject: `${v.businessName} sent you Purchase Order ${v.poNumber} for review`,
    body: `${v.businessName} has sent you a secure link to review and negotiate Purchase Order ${v.poNumber}. Access it here: ${v.secureLinkUrl}. This link expires in 30 days.`,
  }),
  // Batch 2 remediation (HNT-AUTH-003) -- Password Reset was explicitly out
  // of scope during the Auth Redesign; this is the first real content for
  // it. Deliberately generic wording ("If you did not request this...") --
  // never confirms or denies whether the recipient's account exists,
  // matching requestPasswordReset's own always-generic-response guarantee.
  password_reset_requested: (v: TemplateVariables) => ({
    subject: "Reset your HantiOS password",
    body: `Hi ${v.name}, we received a request to reset your password. Reset it here: ${v.resetUrl}. This link expires in 1 hour. If you did not request this, you can safely ignore this email.`,
  }),
  password_reset_completed: (v: TemplateVariables) => ({
    subject: "Your HantiOS password was changed",
    body: `Hi ${v.name}, your password was just changed. You have been logged out of all devices. If this wasn't you, contact support immediately.`,
  }),
} satisfies Record<string, TemplateRenderer>;

export type EmailTemplateKey = keyof typeof templates;

export function renderEmailTemplate(templateKey: EmailTemplateKey, variables: TemplateVariables): { subject: string; body: string } {
  const render = templates[templateKey];
  if (!render) {
    throw new Error(`Unknown email template: ${String(templateKey)}`);
  }
  return render(variables);
}
