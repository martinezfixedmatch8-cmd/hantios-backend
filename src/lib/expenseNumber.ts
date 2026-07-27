import { Prisma } from "@prisma/client";
import { generateId } from "./ids";

// Expense Number (e.g. EXP-000001) is a flat per-business sequence -- no year
// dimension, unlike Sales' Receipt Number (INV-<year>-######). This is a
// deliberately separate, structurally-similar function rather than a
// generalization of getNextReceiptNumber: that function hardcodes the
// receipt_counters table name into its raw SQL (table identifiers aren't
// parameterizable via Prisma.sql bind params) and hardcodes the (business_id,
// year) conflict key and "INV-<year>-" format string, none of which apply
// here. The single INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING
// statement below is atomic at the Postgres level -- concurrent expenses
// racing for the same business's counter row serialize on it, never
// SELECT-then-write.
export async function getNextExpenseNumber(tx: Prisma.TransactionClient, businessId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>(Prisma.sql`
    INSERT INTO expense_counters (id, business_id, last_number)
    VALUES (${generateId()}, ${businessId}, 1)
    ON CONFLICT (business_id)
    DO UPDATE SET last_number = expense_counters.last_number + 1
    RETURNING last_number
  `);

  const lastNumber = rows[0]?.last_number;
  if (lastNumber === undefined) {
    throw new Error("Failed to allocate an expense number");
  }

  return `EXP-${String(lastNumber).padStart(6, "0")}`;
}
