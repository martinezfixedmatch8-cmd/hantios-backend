import { Prisma } from "@prisma/client";
import { generateId } from "./ids";

// PFI-000001, flat per-business sequence -- same atomic
// INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING shape as
// getNextPurchaseOrderNumber/getNextExpenseNumber/getNextCustomerNumber
// (table identifiers aren't parameterizable via Prisma.sql bind params, so
// this repo never generalizes these into one shared helper).
export async function getNextProformaInvoiceNumber(tx: Prisma.TransactionClient, businessId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>(Prisma.sql`
    INSERT INTO proforma_invoice_counters (id, business_id, last_number)
    VALUES (${generateId()}, ${businessId}, 1)
    ON CONFLICT (business_id)
    DO UPDATE SET last_number = proforma_invoice_counters.last_number + 1
    RETURNING last_number
  `);

  const lastNumber = rows[0]?.last_number;
  if (lastNumber === undefined) {
    throw new Error("Failed to allocate a proforma invoice number");
  }

  return `PFI-${String(lastNumber).padStart(6, "0")}`;
}
