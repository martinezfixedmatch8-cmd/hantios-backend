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

// A discriminated union on the literal compensationModel, not the full
// enum -- widens Session A's single-branch closed boundary to two branches
// while keeping the other 6 models (PERCENTAGE/FIXED_PLUS_PERCENTAGE/
// FIXED_PLUS_TIME/PIECE_RATE/CONTRACT/CUSTOM) structurally unwritable
// through this endpoint. Sessions B/C extend this list the same way when
// they build real logic for another model, never loosen it to the bare enum.
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
]);
export type CreateEmployeeCompensationInput = z.infer<typeof createEmployeeCompensationSchema>;
