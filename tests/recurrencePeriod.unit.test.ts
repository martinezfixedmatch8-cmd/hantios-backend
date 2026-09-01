import { computeDuePeriods, advanceRollingPeriod, catchUpWindowStart, MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP } from "../src/lib/recurrencePeriod";

const TZ = "Africa/Nairobi"; // fixed UTC+3, no DST -- keeps assertions deterministic
const DAY_START = new Date(Date.UTC(1970, 0, 1, 0, 0, 0)); // 00:00:00

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

const business = { timezone: TZ, business_day_start_time: DAY_START, created_at: d("2020-01-01") };

describe("recurrencePeriod (HNT-OPS-003)", () => {
  describe("advanceRollingPeriod -- date-fns clamping, confirmed in Phase 0", () => {
    it("weekly advances by exactly 7 days per interval", () => {
      expect(advanceRollingPeriod("weekly", d("2026-01-30"), 1).toISOString().slice(0, 10)).toBe("2026-02-06");
      expect(advanceRollingPeriod("weekly", d("2026-01-30"), 2).toISOString().slice(0, 10)).toBe("2026-02-13");
    });

    it("quarterly clamps Jan 31 + 1 quarter to Apr 30 (April has only 30 days)", () => {
      expect(advanceRollingPeriod("quarterly", d("2026-01-31"), 1).toISOString().slice(0, 10)).toBe("2026-04-30");
    });

    it("yearly clamps Feb 29 (leap) + 1 year to Feb 28 (non-leap)", () => {
      expect(advanceRollingPeriod("yearly", d("2028-02-29"), 1).toISOString().slice(0, 10)).toBe("2029-02-28");
    });

    it("yearly does NOT clamp when the target year is also a leap year", () => {
      expect(advanceRollingPeriod("yearly", d("2024-02-29"), 4).toISOString().slice(0, 10)).toBe("2028-02-29");
    });

    it("throws for a non-rolling frequency", () => {
      expect(() => advanceRollingPeriod("monthly", d("2026-01-01"), 1)).toThrow();
    });
  });

  describe("catchUpWindowStart -- the confirmed per-frequency bounded catch-up windows", () => {
    const now = d("2026-08-31");
    it("daily = 3 days, weekly = 2 weeks, monthly = 2 months, quarterly = 2 quarters, yearly = 1 year", () => {
      expect(catchUpWindowStart("daily", now).toISOString().slice(0, 10)).toBe("2026-08-28");
      expect(catchUpWindowStart("weekly", now).toISOString().slice(0, 10)).toBe("2026-08-17");
      expect(catchUpWindowStart("monthly", now).toISOString().slice(0, 10)).toBe("2026-06-30");
      expect(catchUpWindowStart("quarterly", now).toISOString().slice(0, 10)).toBe("2026-02-28");
      expect(catchUpWindowStart("yearly", now).toISOString().slice(0, 10)).toBe("2025-08-31");
    });
  });

  describe("computeDuePeriods -- monthly (calendar-aligned, per-tick)", () => {
    it("returns the current month only when start_date and next_run are both current", () => {
      const now = d("2026-08-31");
      const recurrence = { frequency: "monthly" as const, interval: 1, start_date: d("2026-08-01"), end_date: null, next_run: null };
      const periods = computeDuePeriods(recurrence, business, now);
      expect(periods.map((p) => p.toISOString().slice(0, 10))).toEqual(["2026-08-01"]);
    });

    it("catches up multiple missed months within the 2-month window, oldest first, bounded by MAX_OCCURRENCES", () => {
      const now = d("2026-08-31");
      const recurrence = { frequency: "monthly" as const, interval: 1, start_date: d("2020-01-01"), end_date: null, next_run: null };
      const periods = computeDuePeriods(recurrence, business, now);
      // window start = subMonths(now, 2) = 2026-06-31 -> first-of-month = 2026-06-01
      expect(periods.map((p) => p.toISOString().slice(0, 10))).toEqual(["2026-06-01", "2026-07-01", "2026-08-01"]);
      expect(periods.length).toBeLessThanOrEqual(MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP);
    });

    it("is floored at the onboarding date (businesses.created_at), never generating before it", () => {
      const now = d("2026-08-31");
      const recentBusiness = { ...business, created_at: d("2026-08-15") };
      const recurrence = { frequency: "monthly" as const, interval: 1, start_date: d("2020-01-01"), end_date: null, next_run: null };
      const periods = computeDuePeriods(recurrence, recentBusiness, now);
      expect(periods.map((p) => p.toISOString().slice(0, 10))).toEqual(["2026-08-01"]);
    });

    it("excludes any period beyond end_date", () => {
      const now = d("2026-08-31");
      const recurrence = { frequency: "monthly" as const, interval: 1, start_date: d("2026-06-01"), end_date: d("2026-07-15"), next_run: null };
      const periods = computeDuePeriods(recurrence, business, now);
      expect(periods.map((p) => p.toISOString().slice(0, 10))).toEqual(["2026-06-01", "2026-07-01"]);
    });
  });

  describe("computeDuePeriods -- daily (calendar-aligned, per-tick)", () => {
    it("returns just today when nothing is due to catch up", () => {
      const now = d("2026-08-31");
      const recurrence = { frequency: "daily" as const, interval: 1, start_date: d("2026-08-30"), end_date: null, next_run: null };
      const periods = computeDuePeriods(recurrence, business, now);
      expect(periods.map((p) => p.toISOString().slice(0, 10))).toEqual(["2026-08-30", "2026-08-31"]);
    });

    it("catches up within the 3-day window only, never further back", () => {
      const now = d("2026-08-31");
      const recurrence = { frequency: "daily" as const, interval: 1, start_date: d("2020-01-01"), end_date: null, next_run: null };
      const periods = computeDuePeriods(recurrence, business, now);
      expect(periods.map((p) => p.toISOString().slice(0, 10))).toEqual(["2026-08-28", "2026-08-29", "2026-08-30"]);
      expect(periods.length).toBe(MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP);
    });
  });

  describe("computeDuePeriods -- weekly/quarterly/yearly (rolling, one-time-at-creation)", () => {
    it("weekly: uses next_run directly when it's within the window and due", () => {
      const now = d("2026-08-31");
      const recurrence = { frequency: "weekly" as const, interval: 1, start_date: d("2026-01-01"), end_date: null, next_run: d("2026-08-28") };
      const periods = computeDuePeriods(recurrence, business, now);
      expect(periods.map((p) => p.toISOString().slice(0, 10))).toEqual(["2026-08-28"]);
    });

    it("weekly: skips forward past occurrences older than the 2-week catch-up window without generating them", () => {
      const now = d("2026-08-31");
      const recurrence = { frequency: "weekly" as const, interval: 1, start_date: d("2020-01-01"), end_date: null, next_run: d("2020-01-06") };
      const periods = computeDuePeriods(recurrence, business, now);
      // Everything older than 2026-08-17 (2 weeks before now) is skipped, not generated.
      for (const p of periods) {
        expect(p.getTime()).toBeGreaterThanOrEqual(d("2026-08-17").getTime());
      }
      expect(periods.length).toBeLessThanOrEqual(MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP);
    });

    it("quarterly: advances by 3 calendar months per interval, clamping correctly, generating every occurrence due within the catch-up window", () => {
      const now = d("2026-08-31");
      const recurrence = { frequency: "quarterly" as const, interval: 1, start_date: d("2026-01-31"), end_date: null, next_run: d("2026-01-31") };
      const periods = computeDuePeriods(recurrence, business, now);
      // window start = subMonths(now, 6) = 2026-02-28; 2026-01-31 is older than
      // that, so it's skipped forward to 2026-04-30 (clamped) -- within window.
      // From there, BOTH 2026-04-30 and its own next occurrence (2026-07-30,
      // still <= today) are legitimately due and both get generated, capped
      // by MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP.
      expect(periods.map((p) => p.toISOString().slice(0, 10))).toEqual(["2026-04-30", "2026-07-30"]);
    });

    it("yearly: a future next_run (not yet due) returns no periods", () => {
      const now = d("2026-08-31");
      const recurrence = { frequency: "yearly" as const, interval: 1, start_date: d("2026-01-01"), end_date: null, next_run: d("2027-01-01") };
      const periods = computeDuePeriods(recurrence, business, now);
      expect(periods).toEqual([]);
    });

    it("respects end_date for rolling frequencies too -- a legitimately-due (within-window) occurrence still gets excluded once past end_date", () => {
      const now = d("2026-08-31");
      // next_run=2026-08-22 is well within the 2-week catch-up window (window
      // start 2026-08-17), so it fires; its own next occurrence (2026-08-29)
      // is also within the window and <= today, but exceeds end_date and must
      // be excluded.
      const recurrence = { frequency: "weekly" as const, interval: 1, start_date: d("2026-08-01"), end_date: d("2026-08-25"), next_run: d("2026-08-22") };
      const periods = computeDuePeriods(recurrence, business, now);
      expect(periods.map((p) => p.toISOString().slice(0, 10))).toEqual(["2026-08-22"]);
    });
  });
});
