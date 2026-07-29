import { Prisma } from "@prisma/client";
import { generateId } from "./ids";

// Customer Number (e.g. CUS-000001) is a flat per-business sequence -- no
// year dimension, mirrors getNextExpenseNumber exactly (a deliberately
// separate, structurally-similar function, not a generalization -- table
// identifiers aren't parameterizable via Prisma.sql bind params). The single
// INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING statement below is
// atomic at the Postgres level -- concurrent customer creations racing for
// the same business's counter row serialize on it, never SELECT-then-write.
// A number allocated to a create that then loses the (business_id,
// phone_normalized)-among-active-customers race is skipped, not reused --
// same accepted gap-not-reuse behavior expense_counters/receipt_counters
// already have.
export async function getNextCustomerNumber(tx: Prisma.TransactionClient, businessId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>(Prisma.sql`
    INSERT INTO customer_counters (id, business_id, last_number)
    VALUES (${generateId()}, ${businessId}, 1)
    ON CONFLICT (business_id)
    DO UPDATE SET last_number = customer_counters.last_number + 1
    RETURNING last_number
  `);

  const lastNumber = rows[0]?.last_number;
  if (lastNumber === undefined) {
    throw new Error("Failed to allocate a customer number");
  }

  return `CUS-${String(lastNumber).padStart(6, "0")}`;
}
