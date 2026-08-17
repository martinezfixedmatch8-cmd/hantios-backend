// General business-timezone utilities -- deliberately not folded into
// receiptNumber.ts, which is its only caller today, so Session 3B's Void/Refund
// day-close comparison (same calendar day in Business.timezone -> Void only;
// later -> Refund only) can reuse this instead of re-deriving timezone math.
export function getBusinessLocalYear(timezone: string, date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  if (!year) {
    throw new Error(`Could not resolve year for timezone: ${timezone}`);
  }
  return Number(year);
}

// Module 12 Session A -- the business's own current calendar month (1-12),
// same reasoning/shape as getBusinessLocalYear above: monthly payroll
// generation must key off the business's own local calendar, never
// server/UTC "now".
export function getBusinessLocalMonth(timezone: string, date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "numeric" }).formatToParts(date);
  const month = parts.find((p) => p.type === "month")?.value;
  if (!month) {
    throw new Error(`Could not resolve month for timezone: ${timezone}`);
  }
  return Number(month);
}

function getLocalDateTimeParts(timezone: string, date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // hour12:false renders midnight as "24" in some ICU builds -- normalize to 0.
  const hour = get("hour") % 24;
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute"), second: get("second") };
}

// Prisma maps a Postgres @db.Time column to a JS Date whose date part is an
// arbitrary epoch and whose time-of-day is expressed in UTC getters (Postgres
// TIME has no timezone of its own -- it isn't affected by the DB session's
// timezone the way TIMESTAMP would be), so extract with getUTC*, never getHours().
function timeOfDaySeconds(time: Date): number {
  return time.getUTCHours() * 3600 + time.getUTCMinutes() * 60 + time.getUTCSeconds();
}

// Buckets a timestamp into its "business day" -- a rolling 24h window starting
// at dayStartTime (Business.business_day_start_time) in the business's own
// timezone, not server/UTC midnight. With the default 00:00:00 start, every
// timestamp's local time-of-day is trivially >= 00:00:00, so this reduces to
// plain "same calendar date in Business.timezone" -- the already-locked rule
// this repo used before Business Day config existed.
export function getBusinessDay(timezone: string, dayStartTime: Date, date: Date = new Date()): string {
  const local = getLocalDateTimeParts(timezone, date);
  const localSeconds = local.hour * 3600 + local.minute * 60 + local.second;
  const startSeconds = timeOfDaySeconds(dayStartTime);

  const businessDay = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (localSeconds < startSeconds) {
    // Hasn't reached this calendar date's business-day start yet -- still
    // belongs to the previous business day. setUTCDate handles month/year
    // rollover correctly on its own.
    businessDay.setUTCDate(businessDay.getUTCDate() - 1);
  }

  const y = businessDay.getUTCFullYear();
  const m = String(businessDay.getUTCMonth() + 1).padStart(2, "0");
  const d = String(businessDay.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isSameBusinessDay(timezone: string, dayStartTime: Date, a: Date, b: Date): boolean {
  return getBusinessDay(timezone, dayStartTime, a) === getBusinessDay(timezone, dayStartTime, b);
}

// Batch 3 remediation (HNT2-COM-001 + HNT-PAY-001) -- the genuine missing
// piece: everything else in this file converts a known UTC instant INTO its
// business-local calendar representation (instant -> local). This is the
// opposite direction -- given a business-local calendar date, resolve the
// real UTC instant it represents (local -> instant) -- which nothing in
// this file did before now (getBusinessDay's own Date.UTC usage just labels
// already-resolved local Y/M/D parts as a bucket string, it never converts
// a local wall-clock time to a UTC instant).
//
// Standard offset-correction technique (the same one production timezone
// libraries use internally, e.g. date-fns-tz's zonedTimeToUtc): guess the
// UTC instant naively (as if the local wall-clock numbers were already
// UTC), render that guess back through Intl.DateTimeFormat for the target
// timezone to see what local wall-clock time it actually represents there,
// then correct the guess by exactly the delta between the intended local
// time and what the guess rendered as. This resolves the REAL, current
// IANA-database offset for that exact instant (via Intl.DateTimeFormat),
// so it's correct across a DST transition, not just a fixed offset --
// deliberately a single-pass correction (not iterative), matching the same
// precedent: a second DST shift landing exactly inside one correction pass
// would need the transition to fall exactly at local midnight, which does
// not happen at real-world month boundaries.
function localMidnightToUtcInstant(timezone: string, year: number, month: number, day: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const rendered = getLocalDateTimeParts(timezone, guess);
  const renderedAsUtcMs = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second);
  const intendedAsUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  return new Date(guess.getTime() + (intendedAsUtcMs - renderedAsUtcMs));
}

// The single canonical period-boundary calculation for filtering a real
// instant DateTime column (e.g. sales.timestamp) by "business's own local
// calendar month N" -- start is local midnight on day 1 of the requested
// month, end is local midnight on day 1 of the following month (exclusive),
// both converted to their real UTC instants. Query as
// `timestamp >= start AND timestamp < end`.
//
// Deliberately NOT used for comparisons against a plain @db.Date column
// (employee_compensation.effective_from/effective_to,
// attendance_records.work_date) -- those columns carry no time-of-day or
// timezone meaning at all (Postgres DATE, not TIMESTAMPTZ), and this
// repo's own established convention for them (dateOnlyString above,
// debts.date_due's own precedent) is to read/write them as bare calendar
// dates via UTC-midnight-labeled values, never as timezone-shifted
// instants. Feeding this function's own business-timezone-shifted instant
// into one of those comparisons would introduce a NEW bug, not fix one --
// confirmed and locked during Batch 3's own Phase 0 review, see
// payroll.service.ts's and attendance.service.ts's own comments at their
// respective (deliberately unchanged) Date.UTC call sites.
//
// December -> January year rollover needs no special-casing: Date.UTC
// (and this function's own month-1 indexing) already normalizes an
// out-of-range month index (13) into January of the following year on its
// own, standard JS Date behavior.
export function getBusinessMonthBounds(
  timezone: string,
  year: number,
  month: number // 1-12
): { start: Date; end: Date } {
  const start = localMidnightToUtcInstant(timezone, year, month, 1);
  const end = localMidnightToUtcInstant(timezone, year, month + 1, 1);
  return { start, end };
}

// `debts.date_due` is a plain @db.Date -- a calendar date the business meant
// literally (no time-of-day, no further timezone conversion needed), unlike
// `timestamp`/`created_at` columns getBusinessDay handles above. Prisma
// returns it as a Date at UTC midnight of that calendar date, so read it with
// getUTC*, the same reasoning timeOfDaySeconds above uses for @db.Time.
export function dateOnlyString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Session 4 (Debts): "today", business-day-aware, compared against a due
// date -- never raw UTC "now" vs "due date". Overdue = the current business
// day (per Business.timezone + businessDayStartTime) is later than the debt's
// due date; equal or earlier is not yet overdue.
export function isOverdue(dueDate: Date, timezone: string, dayStartTime: Date, now: Date = new Date()): boolean {
  return getBusinessDay(timezone, dayStartTime, now) > dateOnlyString(dueDate);
}
