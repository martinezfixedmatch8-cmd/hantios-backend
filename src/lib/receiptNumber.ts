import { Prisma } from "@prisma/client";
import { generateId } from "./ids";
import { getBusinessLocalYear } from "./businessTime";

// Receipt Number (customer-facing, e.g. INV-2026-000001) is distinct from Sale
// Number (sales.id -- already immutable/unique/never-reused, no extra work needed).
// Sequential per business per calendar year (in Business.timezone). The single
// INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING statement below is atomic at
// the Postgres level -- concurrent sales racing for the same (business, year) row
// serialize on it, never SELECT-then-write.
export async function getNextReceiptNumber(
  tx: Prisma.TransactionClient,
  businessId: string,
  timezone: string
): Promise<string> {
  const year = getBusinessLocalYear(timezone);

  const rows = await tx.$queryRaw<{ last_number: number }[]>(Prisma.sql`
    INSERT INTO receipt_counters (id, business_id, year, last_number)
    VALUES (${generateId()}, ${businessId}, ${year}, 1)
    ON CONFLICT (business_id, year)
    DO UPDATE SET last_number = receipt_counters.last_number + 1
    RETURNING last_number
  `);

  const lastNumber = rows[0]?.last_number;
  if (lastNumber === undefined) {
    throw new Error("Failed to allocate a receipt number");
  }

  return `INV-${year}-${String(lastNumber).padStart(6, "0")}`;
}
