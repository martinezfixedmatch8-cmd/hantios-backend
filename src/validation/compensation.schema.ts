import { z } from "zod";
import { decimalField } from "./common.schema";

// Module 12 Session A -- the confirmed Zod validation boundary for
// compensation_config. This session's own API surface accepts ONLY
// compensationModel: "FIXED_MONTHLY" (a Zod literal, not the full 8-value
// CompensationModel enum) -- there is no code path anywhere in this session
// that could write a config for any of the other 7 recognized-but-
// unimplemented models. That's what makes "no arbitrary unvalidated JSON
// writes" true structurally, not just by convention: Sessions B/C get to
// define their own strict schemas for HOURLY/PERCENTAGE/etc. when they
// actually build real logic for them, exactly the same way this file adds
// FIXED_MONTHLY's.
//
// Session D -- exported (not module-private) so CUSTOM v1's own
// composable schema can reuse these SAME sub-schemas directly, per the
// confirmed "reuse, don't duplicate" requirement.
export const fixedMonthlyConfigSchema = z
  .object({
    monthlySalary: decimalField(z.coerce.number().positive()),
  })
  .strict();

// Module 12 Session B -- HOURLY becomes writable. Same decimalField 2dp
// guard as FIXED_MONTHLY's own monthlySalary (Decimal precision, never
// float), confirmed Phase 0 shape: { "hourlyRate": "3.50" }.
export const hourlyConfigSchema = z
  .object({
    hourlyRate: decimalField(z.coerce.number().positive()),
  })
  .strict();

// Module 12 Session C -- PERCENTAGE becomes writable. commissionRate is a
// percentage VALUE (5.00 means 5%), confirmed Phase 0 shape: { "commissionRate": "5.00" }.
export const percentageConfigSchema = z
  .object({
    commissionRate: decimalField(z.coerce.number().positive()),
  })
  .strict();

// FIXED_PLUS_PERCENTAGE -- confirmed genuinely zero-ambiguity (purely
// additive: fixedBase + eligibleSales x rate, no threshold/overtime-style
// question the way FIXED_PLUS_TIME had). fixedBase allows 0 (a
// commission-only structure that happens to be modeled through this branch
// is legitimate, not an error) -- commissionRate stays positive (a
// FIXED_PLUS_PERCENTAGE structure with a 0% rate is just FIXED_MONTHLY,
// use that model instead).
const fixedPlusPercentageConfigSchema = z
  .object({
    fixedBase: decimalField(z.coerce.number().nonnegative()),
    commissionRate: decimalField(z.coerce.number().positive()),
  })
  .strict();

// Module 12 Session D -- FIXED_PLUS_TIME. Threshold/multiplier are always
// business-configured, never hardcoded (confirmed Phase 0) -- there is no
// default applied at this layer; the caller must supply real values (the
// spec's own "sensible default: 8 / 1.5" is a UI-level suggestion, not a
// server-side fallback, matching this repo's "never invent a business
// rule the request didn't ask for" discipline). fixedAmount allows 0 (a
// pure hourly-plus-overtime structure with no base retainer is legitimate).
export const fixedPlusTimeConfigSchema = z
  .object({
    fixedAmount: decimalField(z.coerce.number().nonnegative()),
    hourlyRate: decimalField(z.coerce.number().positive()),
    overtimeThresholdHours: decimalField(z.coerce.number().positive()),
    overtimeMultiplier: decimalField(z.coerce.number().positive()),
  })
  .strict();

// Module 12 Session D -- CONTRACT, using employee_compensation itself as
// the Compensation Agreement (confirmed Phase 0, Path B -- no new module).
// paymentSchedule is a closed literal this session -- MONTHLY only;
// milestone-based payment is confirmed deferred (genuine ambiguity: which
// milestone, how "reached" is determined, who confirms it), so any other
// value is rejected here rather than silently accepted and later
// misinterpreted.
export const contractConfigSchema = z
  .object({
    contractAmount: decimalField(z.coerce.number().positive()),
    contractPeriodMonths: z.number().int().positive(),
    paymentSchedule: z.literal("MONTHLY"),
  })
  .strict();

// Module 12 Session D -- CUSTOM v1, "Composable Compensation" (confirmed
// bounded, NOT a full rules engine -- that's CUSTOM v2, deferred). Each
// component reuses the EXACT SAME sub-schema its own dedicated model
// already uses (imported above, not duplicated) -- calculation logic
// mirrors this exactly (see payroll.service.ts). At least one component is
// required; a CUSTOM structure with zero components is meaningless.
export const customConfigSchema = z
  .object({
    fixedComponent: fixedMonthlyConfigSchema.optional(),
    hourlyComponent: hourlyConfigSchema.optional(),
    percentageComponent: percentageConfigSchema.optional(),
  })
  .strict()
  .refine((c) => c.fixedComponent || c.hourlyComponent || c.percentageComponent, {
    message: "At least one of fixedComponent, hourlyComponent, or percentageComponent is required",
  });

// A discriminated union on the literal compensationModel, not the full
// enum -- widens the boundary to seven branches while keeping the one
// remaining model (PIECE_RATE) structurally unwritable through this
// endpoint (confirmed NOT CALCULABLE YET -- no authoritative output
// source exists anywhere in this repo).
export const createEmployeeCompensationSchema = z.discriminatedUnion("compensationModel", [
  z.object({
    compensationModel: z.literal("FIXED_MONTHLY"),
    effectiveFrom: z.coerce.date(),
    config: fixedMonthlyConfigSchema,
  }),
  z.object({
    compensationModel: z.literal("HOURLY"),
    effectiveFrom: z.coerce.date(),
    config: hourlyConfigSchema,
  }),
  z.object({
    compensationModel: z.literal("PERCENTAGE"),
    effectiveFrom: z.coerce.date(),
    config: percentageConfigSchema,
  }),
  z.object({
    compensationModel: z.literal("FIXED_PLUS_PERCENTAGE"),
    effectiveFrom: z.coerce.date(),
    config: fixedPlusPercentageConfigSchema,
  }),
  z.object({
    compensationModel: z.literal("FIXED_PLUS_TIME"),
    effectiveFrom: z.coerce.date(),
    config: fixedPlusTimeConfigSchema,
  }),
  z.object({
    compensationModel: z.literal("CONTRACT"),
    effectiveFrom: z.coerce.date(),
    config: contractConfigSchema,
  }),
  z.object({
    compensationModel: z.literal("CUSTOM"),
    effectiveFrom: z.coerce.date(),
    config: customConfigSchema,
  }),
]);
export type CreateEmployeeCompensationInput = z.infer<typeof createEmployeeCompensationSchema>;
