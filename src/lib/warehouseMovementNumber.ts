import { Prisma } from "@prisma/client";
import { generateId } from "./ids";

// Warehouse Movement Number (e.g. WSM-000001) -- one shared per-business
// sequence covering BOTH stock_in and stock_out rows (wsm_counters has no
// direction/type dimension), mirroring getNextPurchaseOrderNumber/
// getNextGrnNumber exactly. The single INSERT ... ON CONFLICT ... DO
// UPDATE ... RETURNING statement below is atomic at the Postgres level --
// concurrent stock-in/stock-out writes racing for the same business's
// counter row serialize on it, never SELECT-then-write.
export async function getNextWarehouseMovementNumber(tx: Prisma.TransactionClient, businessId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>(Prisma.sql`
    INSERT INTO wsm_counters (id, business_id, last_number)
    VALUES (${generateId()}, ${businessId}, 1)
    ON CONFLICT (business_id)
    DO UPDATE SET last_number = wsm_counters.last_number + 1
    RETURNING last_number
  `);

  const lastNumber = rows[0]?.last_number;
  if (lastNumber === undefined) {
    throw new Error("Failed to allocate a warehouse movement number");
  }

  return `WSM-${String(lastNumber).padStart(6, "0")}`;
}
