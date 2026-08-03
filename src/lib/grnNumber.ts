import { Prisma } from "@prisma/client";
import { generateId } from "./ids";

// GRN Number (e.g. GRN-000001) is a flat per-business sequence -- no year
// dimension, mirrors getNextPurchaseOrderNumber exactly (a deliberately
// separate, structurally-similar function, not a generalization -- table
// identifiers aren't parameterizable via Prisma.sql bind params). The
// single INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING statement below
// is atomic at the Postgres level -- concurrent GRN creations racing for
// the same business's counter row serialize on it, never SELECT-then-write.
export async function getNextGrnNumber(tx: Prisma.TransactionClient, businessId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>(Prisma.sql`
    INSERT INTO grn_counters (id, business_id, last_number)
    VALUES (${generateId()}, ${businessId}, 1)
    ON CONFLICT (business_id)
    DO UPDATE SET last_number = grn_counters.last_number + 1
    RETURNING last_number
  `);

  const lastNumber = rows[0]?.last_number;
  if (lastNumber === undefined) {
    throw new Error("Failed to allocate a GRN number");
  }

  return `GRN-${String(lastNumber).padStart(6, "0")}`;
}
