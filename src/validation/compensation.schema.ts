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
const fixedMonthlyConfigSchema = z
  .object({
    monthlySalary: decimalField(z.coerce.number().positive()),
  })
  .strict();

// Module 12 Session B -- HOURLY becomes writable. Same decimalField 2dp
// guard as FIXED_MONTHLY's own monthlySalary (Decimal precision, never
// float), confirmed Phase 0 shape: { "hourlyRate": "3.50" }.
const hourlyConfigSchema = z
  .object({
    hourlyRate: decimalField(z.coerce.number().positive()),
  })
  .strict();

// Module 12 Session C -- PERCENTAGE becomes writable. commissionRate is a
// percentage VALUE (5.00 means 5%), confirmed Phase 0 shape: { "commissionRate": "5.00" }.
const percentageConfigSchema = z
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

// A discriminated union on the literal compensationModel, not the full
// enum -- widens Session A/B's boundary to four branches while keeping the
// other 4 models (FIXED_PLUS_TIME/PIECE_RATE/CONTRACT/CUSTOM) structurally
// unwritable through this endpoint. A future session extends this list the
// same way when it builds real logic for another model, never loosens it
// to the bare enum.
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
]);
export type CreateEmployeeCompensationInput = z.infer<typeof createEmployeeCompensationSchema>;
