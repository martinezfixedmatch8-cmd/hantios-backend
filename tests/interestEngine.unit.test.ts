import { Prisma } from "@prisma/client";
import { getPeriodsElapsed, calculateInterest } from "../src/lib/interestEngine";

describe("interestEngine (pure calculation functions)", () => {
  describe("getPeriodsElapsed", () => {
    it("one_time: returns 1 the first time, 0 on every later call regardless of elapsed time", () => {
      const today = new Date("2026-08-01");
      expect(
        getPeriodsElapsed({ calculationPolicy: "one_time", lastAppliedOrTaken: new Date("2020-01-01"), today, alreadyAppliedOnce: false })
      ).toBe(1);
      expect(
        getPeriodsElapsed({ calculationPolicy: "one_time", lastAppliedOrTaken: new Date("2020-01-01"), today, alreadyAppliedOnce: true })
      ).toBe(0);
    });

    it("daily: counts exact calendar days elapsed, never negative", () => {
      expect(
        getPeriodsElapsed({ calculationPolicy: "daily", lastAppliedOrTaken: new Date("2026-07-01"), today: new Date("2026-07-06"), alreadyAppliedOnce: true })
      ).toBe(5);
      expect(
        getPeriodsElapsed({ calculationPolicy: "daily", lastAppliedOrTaken: new Date("2026-07-01"), today: new Date("2026-07-01"), alreadyAppliedOnce: true })
      ).toBe(0);
    });

    it("weekly: floors elapsed days to full 7-day periods (not calendar week boundaries)", () => {
      expect(
        getPeriodsElapsed({ calculationPolicy: "weekly", lastAppliedOrTaken: new Date("2026-07-01"), today: new Date("2026-07-11"), alreadyAppliedOnce: true })
      ).toBe(1); // 10 days -> floor(10/7) = 1
      expect(
        getPeriodsElapsed({ calculationPolicy: "weekly", lastAppliedOrTaken: new Date("2026-07-01"), today: new Date("2026-07-15"), alreadyAppliedOnce: true })
      ).toBe(2); // 14 days -> 2
      expect(
        getPeriodsElapsed({ calculationPolicy: "weekly", lastAppliedOrTaken: new Date("2026-07-01"), today: new Date("2026-07-05"), alreadyAppliedOnce: true })
      ).toBe(0); // 4 days -> 0
    });

    it("monthly: uses true calendar-month arithmetic, including short-month end-of-month clamping", () => {
      expect(
        getPeriodsElapsed({ calculationPolicy: "monthly", lastAppliedOrTaken: new Date("2026-01-15"), today: new Date("2026-02-15"), alreadyAppliedOnce: true })
      ).toBe(1);
      // Mar 31 -> Apr 30 is 1 calendar month, not a fixed 30-day period.
      expect(
        getPeriodsElapsed({ calculationPolicy: "monthly", lastAppliedOrTaken: new Date("2026-03-31"), today: new Date("2026-04-30"), alreadyAppliedOnce: true })
      ).toBe(1);
      // Jan 31 -> Feb 28 (short month, no Feb 31) is still exactly 1 month.
      expect(
        getPeriodsElapsed({ calculationPolicy: "monthly", lastAppliedOrTaken: new Date("2026-01-31"), today: new Date("2026-02-28"), alreadyAppliedOnce: true })
      ).toBe(1);
    });
  });

  describe("calculateInterest", () => {
    const base = {
      principal: new Prisma.Decimal(1000),
      remainingBalance: new Prisma.Decimal(800),
      rate: new Prisma.Decimal(10),
    } as const;

    it("type=none always returns 0 regardless of other inputs", () => {
      const result = calculateInterest({ ...base, type: "none", formula: "simple", percentageBase: "remaining_balance", periodsElapsed: 5 });
      expect(result.toNumber()).toBe(0);
    });

    it("returns 0 when periodsElapsed is 0 or negative", () => {
      const result = calculateInterest({ ...base, type: "percentage", formula: "simple", percentageBase: "remaining_balance", periodsElapsed: 0 });
      expect(result.toNumber()).toBe(0);
    });

    it("type=fixed: a flat rate charged per elapsed period", () => {
      const result = calculateInterest({ ...base, type: "fixed", formula: "simple", percentageBase: "remaining_balance", periodsElapsed: 3 });
      expect(result.toNumber()).toBe(30); // rate 10 x 3 periods
    });

    it("type=percentage, formula=simple, base=original_amount", () => {
      const result = calculateInterest({ ...base, type: "percentage", formula: "simple", percentageBase: "original_amount", periodsElapsed: 2 });
      expect(result.toNumber()).toBe(200); // 1000 x 10% x 2 periods
    });

    it("type=percentage, formula=simple, base=remaining_balance", () => {
      const result = calculateInterest({ ...base, type: "percentage", formula: "simple", percentageBase: "remaining_balance", periodsElapsed: 2 });
      expect(result.toNumber()).toBe(160); // 800 x 10% x 2 periods
    });

    it("type=percentage, formula=compound, base=remaining_balance", () => {
      const result = calculateInterest({ ...base, type: "percentage", formula: "compound", percentageBase: "remaining_balance", periodsElapsed: 2 });
      // 800 * ((1.10)^2 - 1) = 800 * 0.21 = 168
      expect(result.toNumber()).toBe(168);
    });

    it("rounds to 2 decimal places", () => {
      const result = calculateInterest({
        principal: new Prisma.Decimal(333.33),
        remainingBalance: new Prisma.Decimal(333.33),
        rate: new Prisma.Decimal(7),
        type: "percentage",
        formula: "simple",
        percentageBase: "remaining_balance",
        periodsElapsed: 1,
      });
      // 333.33 * 0.07 = 23.3331 -> rounds to 23.33
      expect(result.toNumber()).toBe(23.33);
    });
  });
});
