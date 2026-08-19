import { z } from "zod";
import { DebtStatus } from "@prisma/client";
import { decimalField } from "./common.schema";
import { paginationQuerySchema } from "../lib/pagination";

// Interest fields are deliberately NOT accepted here (removed in the
// scheduler/interest-engine extension) -- Business Settings is the sole
// source of truth for financial policy (locked decision), so createDebt
// reads and snapshots the business's own configured policy instead of
// trusting a client-supplied value. A client-suppliable override here would
// silently violate "no module owns or hardcodes its own copy of financial
// rules."
export const createDebtSchema = z
  .object({
    branchId: z.string().uuid().optional(),
    customerPhone: z.string().trim().min(1).max(30),
    customerName: z.string().trim().min(1).max(200).optional(),
    customerLocation: z.string().trim().min(1).max(300).optional(),
    saleId: z.string().uuid().optional(),
    amountOriginal: decimalField(z.coerce.number().positive()),
    dateTaken: z.coerce.date(),
    dateDue: z.coerce.date(),
    notes: z.string().trim().max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.dateDue < data.dateTaken) {
      ctx.addIssue({ code: "custom", message: "dateDue cannot be before dateTaken", path: ["dateDue"] });
    }
  });
export type CreateDebtInput = z.infer<typeof createDebtSchema>;

export const listDebtsQuerySchema = paginationQuerySchema.extend({
  status: z.nativeEnum(DebtStatus).optional(),
  branchId: z.string().uuid().optional(),
  agingBucket: z.enum(["current", "1-30", "31-60", "61-90", "90+"]).optional(),
  isOverdue: z.coerce.boolean().optional(),
});
export type ListDebtsQuery = z.infer<typeof listDebtsQuerySchema>;

// Batch 5 (HNT2-DEBT-001) -- mirrors customer.schema.ts's own
// customerTimelineQuerySchema exactly (the confirmed precedent: a raw-SQL
// UNION ALL across heterogeneous append-only tables uses cursor/keyset
// pagination, not offset pagination -- see getCustomerTimeline).
export const debtHistoryQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type DebtHistoryQuery = z.infer<typeof debtHistoryQuerySchema>;

export const recordPaymentSchema = z.object({
  amount: decimalField(z.coerce.number().positive()),
  paymentMethodId: z.string().uuid().optional(),
  paymentDate: z.coerce.date().optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const reversePaymentSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;

// Shared shape for the three debt-level status transitions (dispute /
// resolve-dispute / write-off) -- all need the same optimistic-lock version
// plus a required reason, same as Sale Void/Refund.
export const debtStatusActionSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type DebtStatusActionInput = z.infer<typeof debtStatusActionSchema>;

// No "reason" field here unlike dispute/resolve/write-off -- those are human
// judgment calls; applying interest is a policy-driven calculation, and its
// own "why" is already fully captured by the resulting debt_transactions
// row's typed columns (interest_type/formula/percentageBase/etc.), not a
// free-text justification.
export const applyInterestSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type ApplyInterestInput = z.infer<typeof applyInterestSchema>;
