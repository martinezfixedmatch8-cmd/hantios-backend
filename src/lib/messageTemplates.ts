// Real, reusable message-template registry -- not a one-off dictionary for
// the Low Stock Alert alone. `renderTemplate(templateKey, language, variables)`
// is the one entry point every future notification should call through.
// Code-level registry (functions/objects), not an admin-editable CMS -- that
// stays out of scope.
//
// Debt Reminder's existing WhatsApp messages (src/services/debt.service.ts,
// the sendReminder overdue/not-yet-due bodies) are deliberately NOT migrated
// onto this registry this session -- Debts is a separate, already-shipped,
// already-tested module, and migrating 2 message variants x 5 languages
// correctly is real, non-trivial work with no benefit to this session's
// actual goal (closing Module 02). Logged as a named follow-up in CLAUDE.md.
//
// Translation confidence note: English/French/Spanish/Arabic are written
// with high confidence. Somali is a functional first pass, not verified by a
// native speaker -- flagged here and in CLAUDE.md so it gets a real review
// before being trusted for production business communication, matching this
// repo's own practice of flagging interpretations rather than asserting
// unverified confidence.

export type SupportedLanguage = "en" | "so" | "ar" | "fr" | "es";

const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["en", "so", "ar", "fr", "es"];

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

type TemplateVariables = Record<string, string>;
type TemplateRenderer = (variables: TemplateVariables) => string;

const templates: Record<string, Record<SupportedLanguage, TemplateRenderer>> = {
  low_stock_alert: {
    en: (v) => `Low stock alert: ${v.productName} at ${v.branchName} is down to ${v.quantity} units (minimum: ${v.minStockLevel}).`,
    so: (v) => `Digniin — kaydku wuu yaraaday: ${v.productName} ee ${v.branchName} waxa ku hartay ${v.quantity} xabbo (ugu yaraan: ${v.minStockLevel}).`,
    ar: (v) => `تنبيه انخفاض المخزون: ${v.productName} في ${v.branchName} تبقى منه ${v.quantity} وحدة فقط (الحد الأدنى: ${v.minStockLevel}).`,
    fr: (v) => `Alerte stock bas : il ne reste que ${v.quantity} unités de ${v.productName} à ${v.branchName} (minimum : ${v.minStockLevel}).`,
    es: (v) => `Alerta de stock bajo: quedan ${v.quantity} unidades de ${v.productName} en ${v.branchName} (mínimo: ${v.minStockLevel}).`,
  },
  // Registered now for completeness (a reusable registry should have both
  // halves of an alert/recovery pair), but nothing sends this yet this
  // session -- StockRecovered is event + audit log only, no WhatsApp send
  // (confirmed decision, see CLAUDE.md).
  stock_recovered: {
    en: (v) => `Stock recovered: ${v.productName} at ${v.branchName} is back to ${v.quantity} units, above the minimum of ${v.minStockLevel}.`,
    so: (v) => `Kaydku waa soo kabsaday: ${v.productName} ee ${v.branchName} hadda waa ${v.quantity} xabbo, taas oo ka badan ugu yarahaan ${v.minStockLevel}.`,
    ar: (v) => `تم تجديد المخزون: أصبح ${v.productName} في ${v.branchName} ${v.quantity} وحدة، وهو أعلى من الحد الأدنى البالغ ${v.minStockLevel}.`,
    fr: (v) => `Stock reconstitué : ${v.productName} à ${v.branchName} est remonté à ${v.quantity} unités, au-dessus du minimum de ${v.minStockLevel}.`,
    es: (v) => `Stock recuperado: ${v.productName} en ${v.branchName} volvió a ${v.quantity} unidades, por encima del mínimo de ${v.minStockLevel}.`,
  },
};

export type TemplateKey = keyof typeof templates;

// Falls back to English for an unsupported/unset business.language rather
// than throwing -- that field is an unvalidated free string today (confirmed
// via research: always "en" in practice, nothing enforces a fixed set), so a
// bad value must never break a real sale/adjustment that happens to trigger
// a notification.
export function renderTemplate(templateKey: TemplateKey, language: string, variables: TemplateVariables): string {
  const templateSet = templates[templateKey];
  if (!templateSet) {
    throw new Error(`Unknown message template: ${String(templateKey)}`);
  }
  const render = isSupportedLanguage(language) ? templateSet[language] : templateSet.en;
  return render(variables);
}
