import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

// Issuance carries no body -- totalAmount is always server-derived from the
// gating Proforma Invoice's own total (the figure that was actually
// validated as fully covered by advance payments), never client-suppliable
// on the normal path. This keeps the FULLY_PREPAID gate airtight: nothing
// lets a Commercial Invoice be issued for a different amount than what was
// actually verified as paid.
export const issueCommercialInvoiceSchema = z.object({});
export type IssueCommercialInvoiceInput = z.infer<typeof issueCommercialInvoiceSchema>;

// Supersede is the one place a human can adjust the figure -- an explicit,
// reasoned correction to an already-issued invoice (e.g. a data-entry
// mistake, a legitimate post-issuance adjustment), never a routine action.
// reason is required, same "every negative/override action needs one" rule
// Void/Refund/Write-off/Reject already established throughout this repo.
export const supersedeCommercialInvoiceSchema = z.object({
  totalAmount: z.coerce.number().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type SupersedeCommercialInvoiceInput = z.infer<typeof supersedeCommercialInvoiceSchema>;

export const listCommercialInvoicesQuerySchema = paginationQuerySchema;
export type ListCommercialInvoicesQuery = z.infer<typeof listCommercialInvoicesQuerySchema>;
