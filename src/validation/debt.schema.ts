import { z } from "zod";
import { InterestType, DebtStatus } from "@prisma/client";
import { decimalField } from "./common.schema";
import { paginationQuerySchema } from "../lib/pagination";

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
    interestEnabled: z.boolean().optional().default(false),
    interestType: z.nativeEnum(InterestType).optional().default("none"),
    interestValue: decimalField(z.coerce.number().nonnegative()).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.interestEnabled && data.interestType === "none") {
      ctx.addIssue({ code: "custom", message: "interestType must be fixed or percentage when interestEnabled is true", path: ["interestType"] });
    }
    if (data.interestEnabled && data.interestType !== "none" && data.interestValue === undefined) {
      ctx.addIssue({ code: "custom", message: "interestValue is required when interest is enabled", path: ["interestValue"] });
    }
    if (data.interestType === "percentage" && data.interestValue !== undefined && data.interestValue > 100) {
      ctx.addIssue({ code: "custom", message: "Percentage interest value cannot exceed 100", path: ["interestValue"] });
    }
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
