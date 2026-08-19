import { z } from "zod";
import { decimalField } from "./common.schema";
import { paginationQuerySchema } from "../lib/pagination";
import { getCurrency } from "../lib/currencyReference";

const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((code) => getCurrency(code) !== undefined, { message: "must be a valid ISO 4217 currency code" });

export const recordAdvancePaymentSchema = z.object({
  proformaInvoiceId: z.string().uuid(),
  supplierPaymentInstructionId: z.string().uuid(),
  amount: decimalField(z.coerce.number().positive()),
  currency: currencyCodeSchema,
  // Fields only, no conversion logic acts on these -- same "snapshot now,
  // convert later" boundary Purchase Orders' own exchangeRate already
  // established (Module 19's job, not built here).
  exchangeRateSnapshot: z.coerce.number().positive().optional(),
  baseCurrency: currencyCodeSchema.optional(),
  supplierCurrency: currencyCodeSchema.optional(),
  // Reuses the existing payment_methods table (see poAdvancePayment.service.ts's
  // own comment) rather than a new parallel channel-type enum.
  paymentMethodId: z.string().uuid().optional(),
  reference: z.string().trim().max(200).optional(),
  installmentLabel: z.string().trim().max(200).optional(),
  paidAt: z.coerce.date().optional(),
});
export type RecordAdvancePaymentInput = z.infer<typeof recordAdvancePaymentSchema>;

export const listAdvancePaymentsQuerySchema = paginationQuerySchema;
export type ListAdvancePaymentsQuery = z.infer<typeof listAdvancePaymentsQuerySchema>;

// Batch 4 remediation (HNT2-PO-002) -- amount is the positive "how much to
// reverse" the client requests; the service negates it before storing as
// delta_amount. version is required (optimistic-lock guard on the ORIGINAL
// payment, per the confirmed policy).
export const reverseAdvancePaymentSchema = z.object({
  amount: decimalField(z.coerce.number().positive()),
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().nonnegative(),
});
export type ReverseAdvancePaymentInput = z.infer<typeof reverseAdvancePaymentSchema>;
