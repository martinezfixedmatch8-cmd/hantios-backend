import { z } from "zod";
import { decimalField } from "./common.schema";

export const stockInSchema = z.object({
  productId: z.string().uuid(),
  quantity: decimalField(z.coerce.number().positive()),
  unitCost: decimalField(z.coerce.number().nonnegative()),
  notes: z.string().trim().max(2000).optional(),
});
export type StockInInput = z.infer<typeof stockInSchema>;

// LOCKED enum (mirrors prisma/schema.prisma's WarehouseStockOutReason
// comment) -- without this, Stock Out history is much less useful for
// later reporting/analysis.
const STOCK_OUT_REASONS = ["branch_transfer", "adjustment", "damage", "return", "other"] as const;

export const stockOutSchema = z
  .object({
    productId: z.string().uuid(),
    quantity: decimalField(z.coerce.number().positive()),
    reason: z.enum(STOCK_OUT_REASONS),
    destinationBranchId: z.string().uuid().optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.reason === "branch_transfer" && !data.destinationBranchId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "destinationBranchId is required when reason is branch_transfer",
        path: ["destinationBranchId"],
      });
    }
    if (data.reason !== "branch_transfer" && data.destinationBranchId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "destinationBranchId must not be set unless reason is branch_transfer",
        path: ["destinationBranchId"],
      });
    }
  });
export type StockOutInput = z.infer<typeof stockOutSchema>;
