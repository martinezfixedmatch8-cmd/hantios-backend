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
