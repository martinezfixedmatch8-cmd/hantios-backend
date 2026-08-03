import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";
import { attachmentBaseSchema, MAX_NEGOTIATION_ATTACHMENTS_PER_UPLOAD } from "./poNegotiationAttachment.schema";

const FIELD_CHANGED_VALUES = [
  "quantity",
  "unit_price",
  "delivery_date",
  "shipping_method",
  "product_substitution",
  "product_added",
  "product_removed",
] as const;

// Enhancement #1 -- a proposal bundles N coordinated changes, never one
// change per proposal. item_id required for item-scoped types (quantity/
// unit_price/product_substitution/product_removed), forbidden for PO-level
// types (delivery_date/shipping_method) and for product_added (the
// product doesn't exist as a line item yet).
const proposalChangeSchema = z
  .object({
    fieldChanged: z.enum(FIELD_CHANGED_VALUES),
    itemId: z.string().uuid().optional(),
    newValue: z.string().trim().min(1).max(500),
  })
  .superRefine((change, ctx) => {
    const itemScoped = ["quantity", "unit_price", "product_substitution", "product_removed"];
    if (itemScoped.includes(change.fieldChanged) && !change.itemId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `itemId is required when fieldChanged is ${change.fieldChanged}`, path: ["itemId"] });
    }
    if (!itemScoped.includes(change.fieldChanged) && change.itemId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `itemId must not be set when fieldChanged is ${change.fieldChanged}`, path: ["itemId"] });
    }
    if (change.fieldChanged === "quantity") {
      const n = Number(change.newValue);
      if (!Number.isInteger(n) || n <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "newValue for quantity must be a positive integer", path: ["newValue"] });
      }
    }
    if (change.fieldChanged === "unit_price") {
      const n = Number(change.newValue);
      if (!Number.isFinite(n) || n < 0 || Math.round(n * 100) / 100 !== n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "newValue for unit_price must be a valid decimal >= 0 with at most 2 decimal places",
          path: ["newValue"],
        });
      }
    }
    if (change.fieldChanged === "delivery_date" && Number.isNaN(Date.parse(change.newValue))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "newValue for delivery_date must be a valid date", path: ["newValue"] });
    }
    // product_substitution's newValue is the replacement product's id --
    // the actual quantity/unit_cost carry forward unchanged from the
    // existing line item (a coordinated quantity/unit_price change, if also
    // wanted, is a separate change entry in the same proposal -- keeps each
    // change's effect orthogonal and composable).
    if (change.fieldChanged === "product_substitution" && !z.string().uuid().safeParse(change.newValue).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "newValue for product_substitution must be a product id (uuid)", path: ["newValue"] });
    }
    // product_added's newValue is a JSON-encoded {productId, quantity,
    // unitCost} -- there is no existing line item to carry values forward
    // from, so all three must be supplied together.
    if (change.fieldChanged === "product_added") {
      try {
        const parsed = JSON.parse(change.newValue) as { productId?: unknown; quantity?: unknown; unitCost?: unknown };
        const valid =
          typeof parsed.productId === "string" &&
          z.string().uuid().safeParse(parsed.productId).success &&
          typeof parsed.quantity === "number" &&
          Number.isInteger(parsed.quantity) &&
          parsed.quantity > 0 &&
          typeof parsed.unitCost === "number" &&
          parsed.unitCost >= 0;
        if (!valid) throw new Error("shape");
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'newValue for product_added must be JSON like {"productId":"...","quantity":1,"unitCost":10.5}',
          path: ["newValue"],
        });
      }
    }
  });
export type ProposalChangeInput = z.infer<typeof proposalChangeSchema>;

function rejectDuplicateItemChanges(changes: { fieldChanged: string; itemId?: string }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const c of changes) {
    if (!c.itemId) continue;
    const key = `${c.itemId}:${c.fieldChanged}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate change for the same item + field within one proposal` });
      return;
    }
    seen.add(key);
  }
}

// draft create-or-update, both owner and supplier side. `version` is
// required once a draft already exists for this actor+PO (optimistic lock);
// omitted on the very first draft save. changes/attachments use full-
// replace semantics on update (delete-then-recreate), same as PO's own
// PATCH-while-draft line-item replacement.
// Enhancement #2 -- attachments accepted inline, in the SAME submission as
// the proposal's changes/comment, rather than a separate follow-up call.
// Full-replace on update, same as `changes` (delete-then-recreate the
// proposal's own attachment set) -- the standalone
// POST .../negotiation/attachments endpoint (message OR proposal, via XOR)
// still exists separately for attaching to a message, or adding one more
// file to an already-drafted proposal without resending the whole draft.
export const draftProposalSchema = z.object({
  version: z.number().int().nonnegative().optional(),
  comment: z.string().trim().max(2000).optional(),
  changes: z.array(proposalChangeSchema).min(1, "At least one change is required").superRefine(rejectDuplicateItemChanges),
  attachments: z.array(attachmentBaseSchema).max(MAX_NEGOTIATION_ATTACHMENTS_PER_UPLOAD).optional(),
});
export type DraftProposalInput = z.infer<typeof draftProposalSchema>;

export const draftSupplierProposalSchema = draftProposalSchema.extend({
  senderName: z.string().trim().min(1).max(200),
  senderPhone: z.string().trim().min(1).max(30),
});
export type DraftSupplierProposalInput = z.infer<typeof draftSupplierProposalSchema>;

export const submitProposalSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type SubmitProposalInput = z.infer<typeof submitProposalSchema>;

export const submitSupplierProposalSchema = submitProposalSchema.extend({
  senderName: z.string().trim().min(1).max(200),
  senderPhone: z.string().trim().min(1).max(30),
});
export type SubmitSupplierProposalInput = z.infer<typeof submitSupplierProposalSchema>;

export const rejectProposalSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type RejectProposalInput = z.infer<typeof rejectProposalSchema>;

// Reject is a state-changing action available to either party (per the
// spec's "only Accept/Reject/Submit/Approve require identity confirmation"
// rule) -- the supplier-portal variant additionally captures who rejected.
export const rejectSupplierProposalSchema = rejectProposalSchema.extend({
  senderName: z.string().trim().min(1).max(200),
  senderPhone: z.string().trim().min(1).max(30),
});
export type RejectSupplierProposalInput = z.infer<typeof rejectSupplierProposalSchema>;

export const listProposalsQuerySchema = paginationQuerySchema;
export type ListProposalsQuery = z.infer<typeof listProposalsQuerySchema>;
