import { z } from "zod";
import { decimalField } from "./common.schema";
import { paginationQuerySchema } from "../lib/pagination";

// subtotal is always server-derived (from the latest Agreement Snapshot, or
// the PO's own current line items if none exists yet) -- never
// client-suppliable, same "never trust a client-supplied total" principle
// every other module in this repo already follows. shippingCost/insurance
// are genuinely new figures with nothing to derive them from (freight/
// insurance cost agreed with the supplier/carrier, not tracked anywhere
// else in this schema), so they're the only real inputs here.
export const issueProformaInvoiceSchema = z.object({
  shippingCost: decimalField(z.coerce.number().nonnegative()).optional().default(0),
  insurance: decimalField(z.coerce.number().nonnegative()).optional().default(0),
  validUntil: z.string().datetime(),
});
export type IssueProformaInvoiceInput = z.infer<typeof issueProformaInvoiceSchema>;

export const listProformaInvoicesQuerySchema = paginationQuerySchema;
export type ListProformaInvoicesQuery = z.infer<typeof listProformaInvoicesQuerySchema>;
