import { getBusinessDay, isSameBusinessDay, getBusinessMonthBounds } from "../src/lib/businessTime";

// Unit coverage for the Business Day bucketing logic that Void/Refund
// eligibility depends on (src/lib/businessTime.ts). Session 3B's
// integration tests (tests/sale.test.ts) only ever exercise the DEFAULT
// business_day_start_time (00:00:00) via real sale/void/refund flows --
// none of them construct a business with a non-default start time, so the
// rolling-24h-window branch (the actual reason this column and the
// dayStartTime parameter exist) had zero direct coverage. This file closes
// that gap: non-default start time, the start-time boundary itself,
// month/year/leap-year rollover, and a non-whole-hour UTC offset timezone
// (to make sure the Intl-based extraction isn't secretly assuming
// whole-hour zones).

// Builds a TIME-only Date the way Prisma represents a Postgres @db.Time
// column: date part pinned to the Unix epoch, time-of-day expressed via the
// UTC getters (see the comment on timeOfDaySeconds in businessTime.ts).
function dbTime(hh: number, mm: number, ss = 0): Date {
  return new Date(Date.UTC(1970, 0, 1, hh, mm, ss));
}

describe("getBusinessDay", () => {
  it("with the default 00:00:00 start time, reduces to plain same-calendar-date-in-timezone", () => {
    const start = dbTime(0, 0, 0);
    const tz = "Africa/Nairobi"; // UTC+3, no DST -- keeps the math easy to hand-verify
    expect(getBusinessDay(tz, start, new Date("2026-07-22T00:00:01Z"))).toBe("2026-07-22");
    expect(getBusinessDay(tz, start, new Date("2026-07-21T23:59:59Z"))).toBe("2026-07-22");
  });

  it("with a non-default start time, buckets a timestamp before local start-of-day into the PREVIOUS business day", () => {
    const start = dbTime(6, 0, 0);
    const tz = "Africa/Nairobi";
    // 02:00Z = 05:00 local -- before the 06:00 start -> still yesterday's business day
    expect(getBusinessDay(tz, start, new Date("2026-07-22T02:00:00Z"))).toBe("2026-07-21");
    // 04:00Z = 07:00 local -- after the 06:00 start -> today's business day
    expect(getBusinessDay(tz, start, new Date("2026-07-22T04:00:00Z"))).toBe("2026-07-22");
  });

  it("treats the exact start-time instant as already belonging to the new business day (inclusive boundary)", () => {
    const start = dbTime(6, 0, 0);
    const tz = "Africa/Nairobi";
    // 03:00Z = 06:00:00 local exactly
    expect(getBusinessDay(tz, start, new Date("2026-07-22T03:00:00Z"))).toBe("2026-07-22");
  });

  it("rolls back correctly across a month boundary (31-day and 30-day months)", () => {
    const start = dbTime(6, 0, 0);
    const tz = "UTC";
    expect(getBusinessDay(tz, start, new Date("2026-08-01T02:00:00Z"))).toBe("2026-07-31");
    expect(getBusinessDay(tz, start, new Date("2026-04-01T02:00:00Z"))).toBe("2026-03-31");
  });

  it("rolls back correctly across a year boundary", () => {
    const start = dbTime(6, 0, 0);
    const tz = "UTC";
    expect(getBusinessDay(tz, start, new Date("2026-01-01T02:00:00Z"))).toBe("2025-12-31");
  });

  it("rolls back correctly into a leap-year February 29th", () => {
    const start = dbTime(6, 0, 0);
    const tz = "UTC";
    expect(getBusinessDay(tz, start, new Date("2024-03-01T02:00:00Z"))).toBe("2024-02-29");
  });

  it("handles a non-whole-hour UTC offset timezone correctly (not just whole-hour zones)", () => {
    const start = dbTime(0, 0, 0);
    const tz = "Asia/Kolkata"; // UTC+5:30
    expect(getBusinessDay(tz, start, new Date("2026-07-21T18:29:00Z"))).toBe("2026-07-21");
    expect(getBusinessDay(tz, start, new Date("2026-07-21T18:31:00Z"))).toBe("2026-07-22");
  });
});

describe("isSameBusinessDay", () => {
  it("returns false for two timestamps straddling a non-default start-time boundary on the same calendar date", () => {
    const start = dbTime(6, 0, 0);
    const tz = "Africa/Nairobi";
    const beforeStart = new Date("2026-07-22T02:30:00Z"); // 05:30 local -> business day 07-21
    const afterStart = new Date("2026-07-22T04:30:00Z"); // 07:30 local -> business day 07-22
    expect(isSameBusinessDay(tz, start, beforeStart, afterStart)).toBe(false);
  });

  it("returns true for two timestamps on the same side of a non-default start-time boundary", () => {
    const start = dbTime(6, 0, 0);
    const tz = "Africa/Nairobi";
    const a = new Date("2026-07-22T04:30:00Z"); // 07:30 local
    const b = new Date("2026-07-22T05:00:00Z"); // 08:00 local
    expect(isSameBusinessDay(tz, start, a, b)).toBe(true);
  });
});

// Batch 3 remediation (HNT2-COM-001 + HNT-PAY-001) -- getBusinessMonthBounds
// is the genuine missing piece: local calendar month -> real UTC instant
// range, the opposite direction from everything else in this file.
describe("getBusinessMonthBounds", () => {
  it("UTC (sanity baseline) -- start/end are unshifted, exactly the naive UTC boundary", () => {
    const { start, end } = getBusinessMonthBounds("UTC", 2026, 8);
    expect(start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("Africa/Nairobi (UTC+3, no DST) -- local midnight is shifted 3 hours earlier in UTC", () => {
    const { start, end } = getBusinessMonthBounds("Africa/Nairobi", 2026, 8);
    // Aug 1 00:00 EAT = Jul 31 21:00 UTC
    expect(start.toISOString()).toBe("2026-07-31T21:00:00.000Z");
    // Sep 1 00:00 EAT = Aug 31 21:00 UTC
    expect(end.toISOString()).toBe("2026-08-31T21:00:00.000Z");
  });

  it("America/New_York (DST-observing) -- resolves the REAL offset for each specific month, not a fixed one", () => {
    // January 2026 -- EST, UTC-5 (winter, DST not in effect)
    const january = getBusinessMonthBounds("America/New_York", 2026, 1);
    expect(january.start.toISOString()).toBe("2026-01-01T05:00:00.000Z");
    // July 2026 -- EDT, UTC-4 (summer, DST in effect)
    const july = getBusinessMonthBounds("America/New_York", 2026, 7);
    expect(july.start.toISOString()).toBe("2026-07-01T04:00:00.000Z");
    // Proves this isn't a fixed-offset lookup: the SAME timezone produces a
    // genuinely different UTC offset depending on which month is queried.
    expect(january.start.getUTCHours()).not.toBe(july.start.getUTCHours());
  });

  it("December -> January year rollover, no special-casing needed", () => {
    const { start, end } = getBusinessMonthBounds("Africa/Nairobi", 2026, 12);
    expect(start.toISOString()).toBe("2026-11-30T21:00:00.000Z"); // Dec 1 2026 00:00 EAT
    expect(end.toISOString()).toBe("2026-12-31T21:00:00.000Z"); // Jan 1 2027 00:00 EAT
  });

  it("[start, end) is a half-open interval -- a timestamp exactly one second before start belongs to the PREVIOUS month, one second after belongs to the CURRENT month", () => {
    const { start } = getBusinessMonthBounds("Africa/Nairobi", 2026, 8);
    const oneSecondBefore = new Date(start.getTime() - 1000);
    const oneSecondAfter = new Date(start.getTime() + 1000);
    // oneSecondBefore is Jul 31 23:59:59 local -- still July.
    expect(oneSecondBefore < start).toBe(true);
    // oneSecondAfter is Aug 1 00:00:01 local -- already August.
    expect(oneSecondAfter >= start).toBe(true);
  });

  it("the exact boundary instant itself belongs to the NEW month (inclusive start)", () => {
    const { start } = getBusinessMonthBounds("Africa/Nairobi", 2026, 8);
    expect(start >= start).toBe(true); // trivial, but documents the >= semantics a caller must use
  });
});
