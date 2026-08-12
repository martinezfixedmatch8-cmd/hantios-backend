import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

export const markPayrollPaidSchema = z.object({
  version: z.number().int().nonnegative(),
  paymentMethodId: z.string().uuid().optional(),
  // Confirmed free-text, owner-entered -- not system-generated (the spec's
  // own schema sketch never implied a numbering service for this field,
  // matching sales.payment_reference/purchase_order_payments.invoice_reference's
  // existing precedent).
  paymentReference: z.string().trim().min(1).max(200).optional(),
});
export type MarkPayrollPaidInput = z.infer<typeof markPayrollPaidSchema>;

export const bulkPayPendingSchema = z.object({
  paymentMethodId: z.string().uuid().optional(),
  paymentReference: z.string().trim().min(1).max(200).optional(),
});
export type BulkPayPendingInput = z.infer<typeof bulkPayPendingSchema>;

export const generatePayrollSchema = z.object({
  periodYear: z.number().int().min(2020).max(2100).optional(),
  periodMonth: z.number().int().min(1).max(12).optional(),
});
export type GeneratePayrollInput = z.infer<typeof generatePayrollSchema>;

export const listPayrollQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["pending", "paid"]).optional(),
  employeeId: z.string().uuid().optional(),
  periodYear: z.coerce.number().int().optional(),
  periodMonth: z.coerce.number().int().optional(),
});
export type ListPayrollQuery = z.infer<typeof listPayrollQuerySchema>;
