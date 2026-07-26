import { Prisma } from "@prisma/client";
import type { InterestType, InterestFormula, PercentageBase, CalculationPolicy } from "@prisma/client";
import { differenceInCalendarDays, differenceInCalendarMonths } from "date-fns";

// Pure calculation functions only -- no DB access, no Prisma queries. Every
// input a caller needs (the debt's own snapshotted policy, current balances,
// "today") is resolved by debt.service.ts before calling in here, which keeps
// this module trivially unit-testable in isolation and reusable by both the
// manual apply-interest endpoint and any future automated accrual trigger.

export interface PeriodsElapsedInput {
  calculationPolicy: CalculationPolicy;
  lastAppliedOrTaken: Date; // last_interest_applied_at, or date_taken if never applied
  today: Date; // business-local "today" (a real Date constructed from getBusinessDay's string)
  alreadyAppliedOnce: boolean; // last_interest_applied_at !== null
}

// How many full periods have elapsed since the last calculation (or since the
// debt was taken, if never calculated). daily/weekly are unambiguous
// fixed-length units (1 day / 7 days) -- exact, not an approximation.
// monthly is the one genuinely calendar-variable unit and, per locked
// instruction, must use true calendar-month arithmetic (date-fns'
// differenceInCalendarMonths) rather than a fixed 30-day period -- Jan 31 ->
// Feb 28/29 = 1 month, Mar 31 -> Apr 30 = 1 month, matching real ERP
// convention, never a systematic day-count error.
export function getPeriodsElapsed(input: PeriodsElapsedInput): number {
  if (input.calculationPolicy === "one_time") {
    // Only ever fires once, ever, for a given debt -- already-applied debts
    // get 0 on every later call, regardless of how much time has passed.
    return input.alreadyAppliedOnce ? 0 : 1;
  }
  const daysElapsed = differenceInCalendarDays(input.today, input.lastAppliedOrTaken);
  if (input.calculationPolicy === "daily") {
    return Math.max(0, daysElapsed);
  }
  if (input.calculationPolicy === "weekly") {
    // A fixed 7-day period, not date-fns' differenceInCalendarWeeks (which
    // counts calendar week-boundary crossings, e.g. Sunday-to-Sunday --
    // different semantics from "how many full 7-day periods have elapsed").
    return Math.max(0, Math.floor(daysElapsed / 7));
  }
  // monthly
  return Math.max(0, differenceInCalendarMonths(input.today, input.lastAppliedOrTaken));
}

export interface CalculateInterestInput {
  principal: Prisma.Decimal; // debts.amount_original
  remainingBalance: Prisma.Decimal; // debts.amount_remaining
  rate: Prisma.Decimal; // debts.interest_value
  type: InterestType;
  formula: InterestFormula;
  percentageBase: PercentageBase;
  periodsElapsed: number;
}

// Read Business Policy -> Calculate -> Audit -> Save. This function is the
// "Calculate" step only -- debt.service.ts's applyInterest handles the rest
// of that pipeline (writing the immutable debt_transactions row, the audit
// log entry, and updating the debt's balance).
export function calculateInterest(input: CalculateInterestInput): Prisma.Decimal {
  if (input.type === "none" || input.periodsElapsed <= 0) {
    return new Prisma.Decimal(0);
  }

  if (input.type === "fixed") {
    // A flat charge per elapsed period (e.g. a recurring late fee) -- for
    // calculationPolicy=one_time, periodsElapsed is always exactly 1.
    return input.rate.times(input.periodsElapsed).toDecimalPlaces(2);
  }

  // percentage
  const base = input.percentageBase === "original_amount" ? input.principal : input.remainingBalance;
  const rateFraction = input.rate.dividedBy(100);

  if (input.formula === "simple") {
    return base.times(rateFraction).times(input.periodsElapsed).toDecimalPlaces(2);
  }

  // compound: base * ((1 + rate)^periods - 1) -- the total compounded charge
  // for however many periods have elapsed since the last calculation.
  const compoundFactor = rateFraction.plus(1).pow(input.periodsElapsed).minus(1);
  return base.times(compoundFactor).toDecimalPlaces(2);
}
