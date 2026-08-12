import { z } from "zod";
import { decimalField } from "./common.schema";
import { paginationQuerySchema } from "../lib/pagination";

// Module 12 Session B -- confirmed Phase 0 (Q3): a simple per-day hours
// entry, workDate explicitly client-supplied (back-dated entry allowed,
// validated in the service layer as not later than the business's own
// current business day -- confirmed). hoursWorked allows 0 (a legitimate
// "recorded, worked zero hours" entry -- e.g. an absence -- not just a
// positive-hours-only field), matching the >=0 DB CHECK.
const attendanceEntrySchema = z.object({
  employeeId: z.string().uuid(),
  workDate: z.coerce.date(),
  hoursWorked: decimalField(z.coerce.number().nonnegative()),
});

export const createAttendanceRecordSchema = attendanceEntrySchema;
export type CreateAttendanceRecordInput = z.infer<typeof createAttendanceRecordSchema>;

// Confirmed addition (Q1's own "bulk-friendly mark present/absent... roster
// view" language) -- mirrors bulkPayPending's own per-entry-isolated shape,
// not one all-or-nothing transaction.
export const bulkCreateAttendanceSchema = z.object({
  entries: z.array(attendanceEntrySchema).min(1),
});
export type BulkCreateAttendanceInput = z.infer<typeof bulkCreateAttendanceSchema>;

export const listAttendanceQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().uuid().optional(),
  status: z.enum(["recorded", "approved"]).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});
export type ListAttendanceQuery = z.infer<typeof listAttendanceQuerySchema>;

// Confirmed: a real, non-zero, signed correction -- deltaHours != 0 is
// enforced both here and at the DB layer (chk_attendance_adjustments_delta_
// hours_nonzero), same defense-in-depth pattern as every other financial
// CHECK constraint in this repo. reason required, matching every other
// negative/override action here (Void/Refund/Write-off/Reject).
export const createAttendanceAdjustmentSchema = z.object({
  deltaHours: decimalField(z.coerce.number().refine((v) => v !== 0, { message: "deltaHours must not be zero" })),
  reason: z.string().trim().min(1).max(500),
});
export type CreateAttendanceAdjustmentInput = z.infer<typeof createAttendanceAdjustmentSchema>;
