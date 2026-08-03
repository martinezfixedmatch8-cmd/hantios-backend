import { z } from "zod";
import { decimalField } from "./common.schema";

const grnLineItemSchema = z.object({
  poItemId: z.string().uuid(),
  quantityReceived: decimalField(z.coerce.number().positive()),
  unitCostActual: decimalField(z.coerce.number().nonnegative()),
});

function rejectDuplicatePoItems(items: { poItemId: string }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.poItemId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `PO item ${item.poItemId} appears more than once in this GRN` });
      return;
    }
    seen.add(item.poItemId);
  }
}

// version is the PO's own expected version (this GRN also updates the PO's
// derived status), mirroring every other mutation in this repo that needs
// optimistic-lock input on the parent it touches.
export const createGoodsReceivedNoteSchema = z.object({
  version: z.number().int().nonnegative(),
  supplierDeliveryNote: z.string().trim().max(200).optional(),
  varianceNotes: z.string().trim().max(2000).optional(),
  items: z.array(grnLineItemSchema).min(1, "At least one line item is required").superRefine(rejectDuplicatePoItems),
});
export type CreateGoodsReceivedNoteInput = z.infer<typeof createGoodsReceivedNoteSchema>;
