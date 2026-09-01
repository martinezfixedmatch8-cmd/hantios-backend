import { addWeeks, addMonths, addYears, subDays, subWeeks, subMonths, subYears, isBefore, isAfter } from "date-fns";
import { RecurrenceFrequency } from "@prisma/client";
import { getBusinessDay } from "./businessTime";

// HNT-OPS-003 -- confirmed bounded catch-up window per frequency (accepted
// as-proposed in Phase 0, same "idempotent regen, a longer outage is moot
// since the next real tick supersedes it" reasoning as payrollScheduler.ts's
// own CATCH_UP_DAYS=3). Anything older than this window is deliberately
// never generated -- skipped forward past, not attempted.
export function catchUpWindowStart(frequency: RecurrenceFrequency, now: Date): Date {
  switch (frequency) {
    case "daily":
      return subDays(now, 3);
    case "weekly":
      return subWeeks(now, 2);
    case "monthly":
      return subMonths(now, 2);
    case "quarterly":
      return subMonths(now, 6); // 2 quarters
    case "yearly":
      return subYears(now, 1);
  }
}

// Database Safety Invariant #3 -- a global per-sweep processing cap,
// independent of the catch-up window above: a pure safety net against a
// *calculation bug* silently generating an unbounded run of occurrences in
// one sweep. 3 is the natural ceiling the catch-up windows themselves already
// imply (daily's own 3-day window is the worst case; every other frequency's
// window caps at <=2 occurrences) -- under correct operation this should
// never bind; if it ever does, that's a signal to dead-letter and alert a
// human, not to silently keep generating.
export const MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP = 3;

function dateOnlyUtc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function parseBusinessDay(dayString: string): Date {
  const [y, m, d] = dayString.split("-").map(Number);
  return dateOnlyUtc(y, m, d);
}

function addDaysUtc(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function startOfMonthUtc(date: Date): Date {
  return dateOnlyUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

// weekly = +interval weeks; quarterly = +interval*3 calendar months
// (preserving anniversary day); yearly = +interval calendar years. Confirmed
// in Phase 0 (direct execution, not assumed): date-fns's addMonths/addYears
// already implement exactly the required leap-year/month-length policy --
// "use the last valid day of the target month, never roll forward" (e.g.
// Jan 31 + 1 month -> Feb 28, Feb 29 (leap) + 1 year -> Feb 28 (non-leap)) --
// so no custom clamping logic is written here.
export function advanceRollingPeriod(frequency: RecurrenceFrequency, from: Date, interval: number): Date {
  switch (frequency) {
    case "weekly":
      return addWeeks(from, interval);
    case "quarterly":
      return addMonths(from, interval * 3);
    case "yearly":
      return addYears(from, interval);
    default:
      throw new Error(`advanceRollingPeriod called for a non-rolling frequency: ${frequency}`);
  }
}

export interface RecurrenceLike {
  frequency: RecurrenceFrequency;
  interval: number;
  start_date: Date;
  end_date: Date | null;
  next_run: Date | null;
}

export interface BusinessLike {
  timezone: string;
  business_day_start_time: Date;
  created_at: Date;
}

// The single per-frequency period-due calculation. monthly/daily are
// calendar-aligned (per-tick, business-local -- Decision 2); weekly/
// quarterly/yearly are rolling from next_run (one-time-at-creation,
// anniversary-based -- Decision 2). Returns scheduled_period candidates,
// oldest-first, already bounded by: the catch-up window, the onboarding
// floor (businesses.created_at, business-local), recurrence.start_date,
// recurrence.end_date, and MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP.
export function computeDuePeriods(recurrence: RecurrenceLike, business: BusinessLike, now: Date): Date[] {
  const windowStart = catchUpWindowStart(recurrence.frequency, now);
  const onboardingFloor = parseBusinessDay(getBusinessDay(business.timezone, business.business_day_start_time, business.created_at));
  const floor = isAfter(onboardingFloor, recurrence.start_date) ? onboardingFloor : recurrence.start_date;
  const effectiveWindowStart = isAfter(windowStart, floor) ? windowStart : floor;
  const today = parseBusinessDay(getBusinessDay(business.timezone, business.business_day_start_time, now));

  const periods: Date[] = [];
  const withinEndDate = (d: Date) => !recurrence.end_date || !isAfter(d, recurrence.end_date);

  if (recurrence.frequency === "daily") {
    let cursor = isAfter(effectiveWindowStart, today) ? today : effectiveWindowStart;
    while (!isAfter(cursor, today) && periods.length < MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP) {
      if (withinEndDate(cursor)) periods.push(cursor);
      cursor = addDaysUtc(cursor, recurrence.interval);
    }
    return periods;
  }

  if (recurrence.frequency === "monthly") {
    let cursor = startOfMonthUtc(isAfter(effectiveWindowStart, today) ? today : effectiveWindowStart);
    const todayMonthStart = startOfMonthUtc(today);
    while (!isAfter(cursor, todayMonthStart) && periods.length < MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP) {
      if (withinEndDate(cursor)) periods.push(cursor);
      cursor = startOfMonthUtc(addMonths(cursor, recurrence.interval));
    }
    return periods;
  }

  // weekly/quarterly/yearly -- rolling anchor, one-time-at-creation.
  let cursor = recurrence.next_run ?? recurrence.start_date;
  // Skip forward past anything older than the catch-up window WITHOUT
  // generating it -- "a longer outage is moot," matching payrollScheduler's
  // own reasoning; only occurrences within the window are ever attempted.
  while (isBefore(cursor, effectiveWindowStart)) {
    cursor = advanceRollingPeriod(recurrence.frequency, cursor, recurrence.interval);
  }
  while (!isAfter(cursor, today) && periods.length < MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP) {
    if (withinEndDate(cursor)) periods.push(cursor);
    cursor = advanceRollingPeriod(recurrence.frequency, cursor, recurrence.interval);
  }
  return periods;
}
