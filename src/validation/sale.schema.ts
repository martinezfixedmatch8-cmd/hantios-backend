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
    // Module 12 Session C -- WHO is entitled to commission, deliberately
    // separate from cashier_id (WHO processed the transaction, always
    // actor.userId, never client-suppliable). Optional, single-employee,
    // settable by whoever can create the sale (owner/manager/cashier) --
    // this is genuinely who is standing at the register, so allowing them
    // to record it live is the confirmed design. Correcting it afterward
    // requires the dedicated owner/manager-only endpoint, never a re-POST.
    salespersonEmployeeId: z.string().uuid().optional(),
  })
  .refine((data) => data.discount?.type !== "percentage" || data.discount.value <= 100, {
    message: "Percentage discount cannot exceed 100",
    path: ["discount", "value"],
  });
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

// Module 12 Session C -- the ONLY way to correct attribution after creation
// (never a re-POST of the sale). employeeId is nullable (not just
// optional) so attribution can be explicitly cleared, not just reassigned
// -- matching the .optional().nullable() pattern this repo already uses
// everywhere a genuinely-clearable FK exists (Employee's own branchId/
// departmentId/positionId on update).
export const setSaleAttributionSchema = z.object({
  version: z.number().int().nonnegative(),
  employeeId: z.string().uuid().nullable(),
  reason: z.string().trim().min(1).max(500),
});
export type SetSaleAttributionInput = z.infer<typeof setSaleAttributionSchema>;

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

// Sale Refund, Partial Refund & Inventory Restoration -- there must be no
// silent default for what happens to returned inventory (locked
// requirement). Each refund line supports EITHER shape:
//   - simple:  the entire returnedQuantity is uniformly resellable or not,
//              expressed as a single required boolean.
//   - mixed:   a client-computed split (some units resellable, some not),
//              expressed as an explicit restockableQuantity.
// Both are `.strict()` so Zod's union disambiguates purely on which keys
// are present -- a client never sends both `restockable` and
// `restockableQuantity` for the same line, and never both shapes at once.
// The server never derives writeOffQuantity as client input (Section 9's
// own "do not require the frontend to redundantly send both" instruction)
// -- it's always computed server-side as returnedQuantity - restockableQuantity.
const simpleRefundLineSchema = z
  .object({
    lineIndex: z.number().int().nonnegative(),
    returnedQuantity: decimalField(z.coerce.number().positive()),
    restockable: z.boolean(),
  })
  .strict();

const mixedRefundLineSchema = z
  .object({
    lineIndex: z.number().int().nonnegative(),
    returnedQuantity: decimalField(z.coerce.number().positive()),
    restockableQuantity: decimalField(z.coerce.number().nonnegative()),
  })
  .strict()
  .refine((line) => line.restockableQuantity <= line.returnedQuantity, {
    message: "restockableQuantity cannot exceed returnedQuantity",
    path: ["restockableQuantity"],
  });

export const refundSaleLineSchema = z.union([simpleRefundLineSchema, mixedRefundLineSchema]);
export type RefundSaleLineInput = z.infer<typeof refundSaleLineSchema>;

export const refundSaleSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
  items: z.array(refundSaleLineSchema).min(1),
});
export type RefundSaleInput = z.infer<typeof refundSaleSchema>;
