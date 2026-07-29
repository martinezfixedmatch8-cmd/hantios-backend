import { z } from "zod";
import { SaleStatus } from "@prisma/client";
import { decimalField } from "./common.schema";
import { paginationQuerySchema } from "../lib/pagination";

// Discount and tax are sale-level inputs, not per-line -- the schema only has
// discount/discount_type/tax_amount on `sales` (nothing per-line exists). The
// server prorates both down to each line for the immutable per-line snapshot
// (see sale.service.ts), so a client never sends per-line discount/tax/price.
const discountSchema = z.object({
  type: z.enum(["fixed", "percentage"]),
  value: decimalField(z.coerce.number().nonnegative()),
});

const saleLineSchema = z.object({
  productId: z.string().uuid(),
  size: z.string().trim().min(1).optional(),
  quantity: decimalField(z.coerce.number().positive()),
});

export const createSaleSchema = z
  .object({
    branchId: z.string().uuid(),
    customerPhone: z.string().trim().min(1).max(30).optional(),
    // Module 05: mirrors Debt's own customerName field -- without it, every
    // customer auto-provisioned via a Sale would be permanently stuck with a
    // null name until manually edited through PATCH /customers/:id.
    customerName: z.string().trim().min(1).max(200).optional(),
    paymentMethodId: z.string().uuid().optional(),
    paymentReference: z.string().trim().min(1).max(200).optional(),
    discount: discountSchema.optional(),
    taxRate: decimalField(z.coerce.number().min(0).max(100)).optional(),
    items: z.array(saleLineSchema).min(1, "At least one line item is required"),
  })
  .refine((data) => data.discount?.type !== "percentage" || data.discount.value <= 100, {
    message: "Percentage discount cannot exceed 100",
    path: ["discount", "value"],
  });
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

export const listSalesQuerySchema = paginationQuerySchema.extend({
  status: z.nativeEnum(SaleStatus).optional(),
  branchId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});
export type ListSalesQuery = z.infer<typeof listSalesQuerySchema>;

// Reason is required for both -- unlike Products' optimistic-lock actions
// (versionedActionSchema in product.schema.ts), Void/Refund always need a
// stated reason, so this isn't reused from there.
export const voidSaleSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type VoidSaleInput = z.infer<typeof voidSaleSchema>;

export const refundSaleSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type RefundSaleInput = z.infer<typeof refundSaleSchema>;
