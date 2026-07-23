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
  beforeDueDays: number; // send a "before due" reminder this many days ahead of date_due
  overdueDays: number; // send an "overdue" reminder this many days after date_due
}

// Settings -> Debts -> reminder timing. No hardcoded schedule -- read from
// Business.settings the same defensive way requiresOtpForNewDevices does,
// falling back to sane defaults only when the business hasn't configured its
// own. Session 4 only builds the manual-trigger endpoint that reads this
// (POST /debts/:id/remind) -- the future automated Reminder Scheduler
// (hardening roadmap Session 7+) reads the exact same settings key, it does
// not get its own.
export function getDebtReminderSchedule(settings: Prisma.JsonValue): DebtReminderSchedule {
  const fallback: DebtReminderSchedule = {
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
    beforeDueDays: typeof r.beforeDueDays === "number" && r.beforeDueDays >= 0 ? r.beforeDueDays : fallback.beforeDueDays,
    overdueDays: typeof r.overdueDays === "number" && r.overdueDays >= 0 ? r.overdueDays : fallback.overdueDays,
  };
}
