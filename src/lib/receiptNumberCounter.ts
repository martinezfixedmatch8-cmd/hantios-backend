import { Prisma } from "@prisma/client";
import { generateId } from "./ids";
import { getBusinessLocalYear } from "./businessTime";

// Module 06 (Receipt System) -- deliberately a NEW, separate file/table from
// the pre-existing receiptNumber.ts/receipt_counters (Sales' own narrower,
// hardcoded-"INV"-prefix mechanism from Session 3A, confirmed left
// untouched). One shared (business, year) sequence across all six receipt
// types, same atomic INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING
// shape every numbering file in this repo uses -- never SELECT MAX+1.
//
// The prefix is deliberately NOT stored on the counter row -- it's read
// fresh from Business.settings (getReceiptSettings) at the moment of
// formatting, after the atomic increment. This is what makes "a business
// changing its receipt prefix does not reset the sequence" true by
// construction: last_number only ever depends on (business_id, year); the
// prefix is pure string formatting applied on top of whatever the DB
// already returned.
export async function getNextReceiptDocumentNumber(
  tx: Prisma.TransactionClient,
  businessId: string,
  timezone: string,
  prefix: string
): Promise<string> {
  const year = getBusinessLocalYear(timezone);

  const rows = await tx.$queryRaw<{ last_number: number }[]>(Prisma.sql`
    INSERT INTO receipt_number_counters (id, business_id, year, last_number)
    VALUES (${generateId()}, ${businessId}, ${year}, 1)
    ON CONFLICT (business_id, year)
    DO UPDATE SET last_number = receipt_number_counters.last_number + 1
    RETURNING last_number
  `);

  const lastNumber = rows[0]?.last_number;
  if (lastNumber === undefined) {
    throw new Error("Failed to allocate a receipt number");
  }

  return `${prefix}-${year}-${String(lastNumber).padStart(6, "0")}`;
}
