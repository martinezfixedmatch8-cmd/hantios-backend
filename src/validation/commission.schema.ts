import { z } from "zod";
import { decimalField } from "./common.schema";

// Module 12 Session C -- the confirmed manual, one-sided correction
// primitive against an ALREADY-ISSUED payroll_records row. deltaAmount is
// signed (Decimal, 2dp, matching every other money field in this repo) --
// != 0 is enforced both here and at the DB layer
// (chk_commission_adjustments_delta_amount_nonzero), same defense-in-depth
// pattern as Attendance's own adjustment deltaHours.
export const createCommissionAdjustmentSchema = z.object({
  employeeId: z.string().uuid(),
  payrollRecordId: z.string().uuid(),
  saleId: z.string().uuid().optional(),
  deltaAmount: decimalField(z.coerce.number().refine((v) => v !== 0, { message: "deltaAmount must not be zero" })),
  reason: z.string().trim().min(1).max(500),
});
export type CreateCommissionAdjustmentInput = z.infer<typeof createCommissionAdjustmentSchema>;
