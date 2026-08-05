import { Prisma } from "@prisma/client";
import { generateId } from "./ids";
import { getBusinessLocalYear } from "./businessTime";

// Shipment Number (SHP-2026-000001) -- year-scoped, mirroring
// receiptNumber.ts's exact (business_id, year) shape, NOT the flat
// po_number/grn_number sequence every other Module 11 document uses --
// the addendum's own example is year-scoped. Same atomic
// INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING statement, never
// SELECT MAX+1.
export async function getNextShipmentNumber(tx: Prisma.TransactionClient, businessId: string, timezone: string): Promise<string> {
  const year = getBusinessLocalYear(timezone);

  const rows = await tx.$queryRaw<{ last_number: number }[]>(Prisma.sql`
    INSERT INTO shipment_counters (id, business_id, year, last_number)
    VALUES (${generateId()}, ${businessId}, ${year}, 1)
    ON CONFLICT (business_id, year)
    DO UPDATE SET last_number = shipment_counters.last_number + 1
    RETURNING last_number
  `);

  const lastNumber = rows[0]?.last_number;
  if (lastNumber === undefined) {
    throw new Error("Failed to allocate a shipment number");
  }

  return `SHP-${year}-${String(lastNumber).padStart(6, "0")}`;
}
