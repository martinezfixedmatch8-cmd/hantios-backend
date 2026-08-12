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

export const createEmployeeCompensationSchema = z.object({
  compensationModel: z.literal("FIXED_MONTHLY"),
  effectiveFrom: z.coerce.date(),
  config: fixedMonthlyConfigSchema,
});
export type CreateEmployeeCompensationInput = z.infer<typeof createEmployeeCompensationSchema>;
