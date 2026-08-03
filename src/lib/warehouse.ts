import { Prisma } from "@prisma/client";
import { generateId } from "./ids";

// Exactly one warehouse per business (warehouses.business_id is @unique) --
// lazily created on first use rather than at signup, same "don't touch
// already-shipped, tested auth.service.ts" reasoning already established
// for ensureSystemCategoriesSeeded. No warehouseId is ever accepted from a
// client -- there is only one valid value per business, so every caller
// resolves it internally via this one function.
//
// Atomic `INSERT ... ON CONFLICT ... DO NOTHING` -- NOT a plain `upsert`,
// and NOT a try/catch-P2002-then-recover pattern either. A live 8-way
// concurrency stress test (8 simultaneous first-ever stock-ins for a
// brand-new business) went through two failed attempts before this one:
//   1. `tx.warehouses.upsert(...)` -- only 1 of 8 succeeded, the other 7
//      threw an unhandled P2002 (upsert's presumed atomicity didn't hold up
//      under this stack's Prisma 7 + @prisma/adapter-neon interactive-
//      transaction combination) -- surfaced as a 500.
//   2. find-then-`create()`-with-a-catch-P2002-fallback-SELECT -- same root
//      symptom, worse failure mode: Postgres poisons the ENTIRE transaction
//      after any failed statement (`current transaction is aborted,
//      commands ignored until end of transaction block`, 25P02) until an
//      explicit ROLLBACK, and the recovery SELECT, still inside that same
//      poisoned transaction, failed too. This is the exact same bug class
//      Customer Records' `findOrCreateCustomer` already hit and fixed this
//      way (see "Customer Records — Module 05" above) -- reusing that
//      proven fix here rather than rediscovering it.
// `DO NOTHING` never throws in the first place, so there is nothing to
// recover from mid-transaction: a lost race returns zero rows, not an
// error, and the follow-up SELECT runs in a still-healthy transaction.
export async function getOrCreateWarehouse(tx: Prisma.TransactionClient, businessId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO warehouses (id, business_id, name, created_at)
    VALUES (${generateId()}, ${businessId}, 'Main Warehouse', now())
    ON CONFLICT (business_id) DO NOTHING
    RETURNING id
  `);
  if (rows.length > 0) {
    return tx.warehouses.findUniqueOrThrow({ where: { id: rows[0].id } });
  }
  return tx.warehouses.findUniqueOrThrow({ where: { business_id: businessId } });
}
