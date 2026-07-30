import { z } from "zod";
import { decimalField } from "./common.schema";
import { paginationQuerySchema } from "../lib/pagination";

const poLineItemSchema = z.object({
  productId: z.string().uuid(),
  // Requirement #9: quantityOrdered > 0, unitCostSnapshot >= 0.
  quantityOrdered: decimalField(z.coerce.number().positive()),
  unitCostSnapshot: decimalField(z.coerce.number().nonnegative()),
});

// Requirement #8 (locked): duplicate products are REJECTED, never silently
// merged -- a client mistake (e.g. a form-state bug sending the same
// product twice) must fail fast, same principle as every other
// Zod-validated input in this codebase.
function rejectDuplicateProducts(items: { productId: string }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.productId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Product ${item.productId} appears more than once in this order` });
      return;
    }
    seen.add(item.productId);
  }
}

export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  // exchangeRate: fields only, no calculation logic acts on this yet
  // (Requirement #4) -- higher precision than the usual 2dp money fields
  // (schema stores Decimal(14,6)), so not run through the shared
  // decimalField() 2dp guard.
  exchangeRate: z.coerce.number().positive().optional(),
  // Requirement #9: at least one line item required -- reject an empty PO outright.
  items: z.array(poLineItemSchema).min(1, "At least one line item is required").superRefine(rejectDuplicateProducts),
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

// DRAFT-only in the fullest sense (Somali clarification): every field here
// is only ever actually applied while status is still draft -- enforced at
// the service layer's atomic guarded update, not just by this schema.
export const updatePurchaseOrderSchema = z.object({
  version: z.number().int().nonnegative(),
  supplierId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional().nullable(),
  exchangeRate: z.coerce.number().positive().optional().nullable(),
  // Full-replace semantics when provided (mirrors Expenses' Session 5B tag
  // full-replace precedent): omitted = items untouched, provided = the
  // complete desired line-item set, delete-then-recreate.
  items: z.array(poLineItemSchema).min(1, "At least one line item is required").superRefine(rejectDuplicateProducts).optional(),
});
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;

export const sendPurchaseOrderSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type SendPurchaseOrderInput = z.infer<typeof sendPurchaseOrderSchema>;

export const confirmPurchaseOrderSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type ConfirmPurchaseOrderInput = z.infer<typeof confirmPurchaseOrderSchema>;

export const cancelPurchaseOrderSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type CancelPurchaseOrderInput = z.infer<typeof cancelPurchaseOrderSchema>;

export const listPurchaseOrdersQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["draft", "sent", "confirmed", "partially_received", "received", "paid", "cancelled"]).optional(),
});
export type ListPurchaseOrdersQuery = z.infer<typeof listPurchaseOrdersQuerySchema>;
