import type { Prisma } from "@prisma/client";

// Settings -> Security -> "Require OTP for New Devices" toggle, per the locked Auth
// Architecture spec. Business.settings is an arbitrary JSONB catch-all, so this reads
// defensively rather than assuming shape.
export function requiresOtpForNewDevices(settings: Prisma.JsonValue): boolean {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return false;
  }
  const security = (settings as Record<string, unknown>).security;
  if (typeof security !== "object" || security === null || Array.isArray(security)) {
    return false;
  }
  return (security as Record<string, unknown>).requireOtpForNewDevices === true;
}

const DEFAULT_REMINDER_BEFORE_DUE_DAYS = 3;
const DEFAULT_REMINDER_OVERDUE_DAYS = 7;

export interface DebtReminderSchedule {
  enabled: boolean; // a business can opt out of automated reminders entirely
  beforeDueDays: number; // send a "before due" reminder this many days ahead of date_due
  overdueDays: number; // send an "overdue" reminder this many days after date_due
}

// Settings -> Debts -> reminder timing. No hardcoded schedule -- read from
// Business.settings the same defensive way requiresOtpForNewDevices does,
// falling back to sane defaults only when the business hasn't configured its
// own. `enabled` defaults true -- reminders were already an expected Session 4
// feature, not a new opt-in the way Interest is; a business explicitly turns
// them off if it wants to. Read by both the manual-trigger endpoint
// (POST /debts/:id/remind) and the automated scheduler (reminderScheduler.ts)
// -- one settings key, one reader, no duplicated schedule logic.
export function getDebtReminderSchedule(settings: Prisma.JsonValue): DebtReminderSchedule {
  const fallback: DebtReminderSchedule = {
    enabled: true,
    beforeDueDays: DEFAULT_REMINDER_BEFORE_DUE_DAYS,
    overdueDays: DEFAULT_REMINDER_OVERDUE_DAYS,
  };
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return fallback;
  }
  const debts = (settings as Record<string, unknown>).debts;
  if (typeof debts !== "object" || debts === null || Array.isArray(debts)) {
    return fallback;
  }
  const reminders = (debts as Record<string, unknown>).reminders;
  if (typeof reminders !== "object" || reminders === null || Array.isArray(reminders)) {
    return fallback;
  }
  const r = reminders as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : fallback.enabled,
    beforeDueDays: typeof r.beforeDueDays === "number" && r.beforeDueDays >= 0 ? r.beforeDueDays : fallback.beforeDueDays,
    overdueDays: typeof r.overdueDays === "number" && r.overdueDays >= 0 ? r.overdueDays : fallback.overdueDays,
  };
}

const DEFAULT_INTEREST_TYPE = "none" as const;
const DEFAULT_CALCULATION_POLICY = "one_time" as const;
const DEFAULT_FORMULA = "simple" as const;
const DEFAULT_PERCENTAGE_BASE = "remaining_balance" as const;

export interface DebtInterestPolicy {
  enabled: boolean;
  type: "none" | "fixed" | "percentage";
  value: number;
  calculationPolicy: "one_time" | "daily" | "weekly" | "monthly";
  formula: "simple" | "compound";
  percentageBase: "original_amount" | "remaining_balance";
}

// Settings -> Debts -> interest policy. This is Tier 3 of the locked 3-tier
// architecture (system capabilities are the enums in schema.prisma; Tier 2
// defaults are hardcoded ONLY here, as safe fallbacks; Tier 3 -- the only
// place a real, active policy value lives -- is each business's own
// Business.settings). `enabled` defaults false -- interest is never silently
// on for a new business, opt-in only, per the locked decision. HantiOS is a
// global ERP: no region's interest norm (simple/one-time or otherwise) is
// assumed here: a business in a jurisdiction/religion where interest isn't
// permitted leaves this disabled; one that permits it configures its own
// type/formula/base. Debt creation snapshots whatever this returns onto the
// new debt (see debt.service.ts's createDebt) -- this function itself is
// never called again for an existing debt's calculations.
export function getDebtInterestPolicy(settings: Prisma.JsonValue): DebtInterestPolicy {
  const fallback: DebtInterestPolicy = {
    enabled: false,
    type: DEFAULT_INTEREST_TYPE,
    value: 0,
    calculationPolicy: DEFAULT_CALCULATION_POLICY,
    formula: DEFAULT_FORMULA,
    percentageBase: DEFAULT_PERCENTAGE_BASE,
  };
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return fallback;
  }
  const debts = (settings as Record<string, unknown>).debts;
  if (typeof debts !== "object" || debts === null || Array.isArray(debts)) {
    return fallback;
  }
  const policy = (debts as Record<string, unknown>).interestPolicy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return fallback;
  }
  const p = policy as Record<string, unknown>;
  const validTypes = ["none", "fixed", "percentage"];
  const validPolicies = ["one_time", "daily", "weekly", "monthly"];
  const validFormulas = ["simple", "compound"];
  const validBases = ["original_amount", "remaining_balance"];
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : fallback.enabled,
    type: typeof p.type === "string" && validTypes.includes(p.type) ? (p.type as DebtInterestPolicy["type"]) : fallback.type,
    value: typeof p.value === "number" && p.value >= 0 ? p.value : fallback.value,
    calculationPolicy:
      typeof p.calculationPolicy === "string" && validPolicies.includes(p.calculationPolicy)
        ? (p.calculationPolicy as DebtInterestPolicy["calculationPolicy"])
        : fallback.calculationPolicy,
    formula:
      typeof p.formula === "string" && validFormulas.includes(p.formula)
        ? (p.formula as DebtInterestPolicy["formula"])
        : fallback.formula,
    percentageBase:
      typeof p.percentageBase === "string" && validBases.includes(p.percentageBase)
        ? (p.percentageBase as DebtInterestPolicy["percentageBase"])
        : fallback.percentageBase,
  };
}

const DEFAULT_RECEIPT_PREFIX = "RCP";
const DEFAULT_RECEIPT_LANGUAGE = "en";
// Kept as a plain string union here (not importing SupportedLanguage from
// messageTemplates.ts) to avoid a cross-lib dependency for a 5-value list;
// receiptRenderer.ts is the single place that actually enforces this set
// against SupportedLanguage.
const VALID_RECEIPT_LANGUAGES = ["en", "so", "ar", "fr", "es"];

export interface ReceiptSettings {
  prefix: string; // e.g. "RCP" -> RCP-2026-000001. Changing this never resets the underlying sequence.
  language: string; // Receipt/Invoice Language (Business Settings 12.1) -- independent of Business.language (UI language)
}

// Settings -> Receipts -> {prefix, language}. Module 06 -- same defensive-
// read pattern as every Tier-3 setting above. Deliberately its OWN settings
// key (`receipts`), never Business.language -- the locked requirement is
// explicit that Receipt/Invoice Language must be independent of UI
// language, so reusing that column would violate the requirement outright,
// not just be untidy.
export function getReceiptSettings(settings: Prisma.JsonValue): ReceiptSettings {
  const fallback: ReceiptSettings = { prefix: DEFAULT_RECEIPT_PREFIX, language: DEFAULT_RECEIPT_LANGUAGE };
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return fallback;
  }
  const receipts = (settings as Record<string, unknown>).receipts;
  if (typeof receipts !== "object" || receipts === null || Array.isArray(receipts)) {
    return fallback;
  }
  const r = receipts as Record<string, unknown>;
  const prefix = typeof r.prefix === "string" && /^[A-Za-z0-9]{1,10}$/.test(r.prefix) ? r.prefix.toUpperCase() : fallback.prefix;
  const language = typeof r.language === "string" && VALID_RECEIPT_LANGUAGES.includes(r.language) ? r.language : fallback.language;
  return { prefix, language };
}
