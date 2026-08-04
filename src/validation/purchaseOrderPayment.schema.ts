import { z } from "zod";
import { decimalField } from "./common.schema";

// matchOverride is the required escape hatch when the 3-way match fails
// (see purchaseOrderPayment.service.ts's recordPurchaseOrderPayment) --
// mirrors every other negative/override action in this repo (write-off,
// dispute, reject) requiring a reason.
const matchOverrideSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

// Session 2B -- invoiceAmount is now OPTIONAL. When a current (issued)
// Commercial Invoice exists for the PO, its own total_amount is the
// authoritative match input and any client-supplied value here is ignored;
// invoiceAmount stays required (enforced in the service layer, since Zod
// alone can't see whether a Commercial Invoice exists) only for a PO that
// hasn't reached that stage yet -- byte-identical to Session B's original
// behavior for every PO without one, including every pre-existing test.
export const recordPurchaseOrderPaymentSchema = z.object({
  version: z.number().int().nonnegative(),
  amount: decimalField(z.coerce.number().positive()),
  invoiceAmount: decimalField(z.coerce.number().positive()).optional(),
  invoiceReference: z.string().trim().max(200).optional(),
  paymentDate: z.coerce.date(),
  notes: z.string().trim().max(2000).optional(),
  matchOverride: matchOverrideSchema.optional(),
});
export type RecordPurchaseOrderPaymentInput = z.infer<typeof recordPurchaseOrderPaymentSchema>;
