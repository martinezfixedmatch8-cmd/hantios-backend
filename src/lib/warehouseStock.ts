import { Prisma } from "@prisma/client";
import { generateId } from "./ids";
import { conflict } from "./errors";
import { getNextWarehouseMovementNumber } from "./warehouseMovementNumber";

export type WarehouseMovementDirection = "stock_in" | "stock_out";
export type WarehouseStockOutReasonValue = "branch_transfer" | "adjustment" | "damage" | "return" | "other";

export interface RecordWarehouseMovementParams {
  businessId: string;
  warehouseId: string;
  productId: string;
  quantity: Prisma.Decimal;
  movementType: WarehouseMovementDirection;
  grnId?: string | null;
  unitCost?: Prisma.Decimal | null;
  destinationBranchId?: string | null;
  reason?: WarehouseStockOutReasonValue | null;
  notes?: string | null;
  createdBy: string;
}

// warehouse_stock.size is never a real dimension for anything this feature
// writes (no PO/GRN/manual-movement line item ever carries a size), so this
// module always uses an EMPTY STRING sentinel here, never NULL. This is
// deliberate and load-bearing, not cosmetic: Postgres does not treat NULL as
// equal to NULL for uniqueness purposes, so the existing
// @@unique([warehouse_id, product_id, size]) constraint can never fire for
// two concurrent creates when size IS NULL -- confirmed live: an initial
// version of this function stored NULL and used a plain findFirst-then-
// create/update, and a concurrency test (two simultaneous stock-ins of 3
// each against a brand-new product) silently produced TWO rows of 3 (6
// total in the table) instead of one row correctly incremented to 6. A
// first attempted fix (a transaction-scoped pg_advisory_xact_lock) was
// abandoned after it produced a genuine multi-hour hang under this
// project's Prisma 7 + @prisma/adapter-neon (serverless) stack, root cause
// unconfirmed -- rather than debug an unproven locking primitive against an
// unfamiliar serverless driver, this rewrite uses the SAME atomic
// `INSERT ... ON CONFLICT ... RETURNING` pattern every counter table in
// this repo (po_counters, grn_counters, wsm_counters, ...) already relies
// on and has been verified correct under real concurrency. Using '' instead
// of NULL makes the existing unique index a REAL guard (Postgres treats two
// empty strings as equal), so ON CONFLICT can actually detect and
// atomically resolve the race in one round trip -- no advisory lock, no
// separate findFirst, no race window at all.
const NO_SIZE = "";

// The single choke point for every quantity change to warehouse_stock --
// manual Stock In, manual Stock Out, and GRN-triggered stock-in (via
// goodsReceivedNote.service.ts) all call this identically, differing only
// in which optional fields (grnId/unitCost vs destinationBranchId/reason)
// they populate.
export async function recordWarehouseMovement(tx: Prisma.TransactionClient, params: RecordWarehouseMovementParams) {
  let quantityAfter: Prisma.Decimal;

  if (params.movementType === "stock_in") {
    // Atomic upsert: creates the row at `quantity` if none exists yet
    // (opening balance), or increments it if one already does -- one round
    // trip, DB-decided, no race window regardless of concurrency.
    const rows = await tx.$queryRaw<{ quantity: Prisma.Decimal }[]>(Prisma.sql`
      INSERT INTO warehouse_stock (id, business_id, warehouse_id, product_id, size, quantity, version, last_updated)
      VALUES (${generateId()}, ${params.businessId}, ${params.warehouseId}, ${params.productId}, ${NO_SIZE}, ${params.quantity}, 0, now())
      ON CONFLICT (warehouse_id, product_id, size)
      DO UPDATE SET quantity = warehouse_stock.quantity + EXCLUDED.quantity, version = warehouse_stock.version + 1, last_updated = now()
      RETURNING quantity
    `);
    quantityAfter = new Prisma.Decimal(rows[0].quantity);
  } else {
    // Atomic conditional decrement -- WHERE quantity >= X is the DB-decided
    // accept/reject, same "one atomic statement" philosophy as Sales' own
    // branch_inventory decrement. Never creates a row that doesn't already
    // exist (stock-out against nothing is a clean conflict, not an opening
    // balance).
    const rows = await tx.$queryRaw<{ quantity: Prisma.Decimal }[]>(Prisma.sql`
      UPDATE warehouse_stock
      SET quantity = quantity - ${params.quantity}, version = version + 1, last_updated = now()
      WHERE business_id = ${params.businessId} AND warehouse_id = ${params.warehouseId} AND product_id = ${params.productId}
        AND size = ${NO_SIZE} AND quantity >= ${params.quantity}
      RETURNING quantity
    `);
    if (rows.length === 0) {
      const existing = await tx.warehouse_stock.findFirst({
        where: { business_id: params.businessId, warehouse_id: params.warehouseId, product_id: params.productId, size: NO_SIZE },
      });
      throw existing
        ? conflict("Insufficient warehouse stock for this movement")
        : conflict("No warehouse stock record exists for this product; cannot stock out");
    }
    quantityAfter = new Prisma.Decimal(rows[0].quantity);
  }

  const quantityBefore =
    params.movementType === "stock_in" ? quantityAfter.minus(params.quantity) : quantityAfter.plus(params.quantity);

  const movementNumber = await getNextWarehouseMovementNumber(tx, params.businessId);

  const movement = await tx.warehouse_movements.create({
    data: {
      id: generateId(),
      business_id: params.businessId,
      warehouse_id: params.warehouseId,
      movement_number: movementNumber,
      movement_type: params.movementType,
      product_id: params.productId,
      quantity: params.quantity,
      quantity_before: quantityBefore,
      quantity_after: quantityAfter,
      grn_id: params.grnId ?? null,
      unit_cost: params.unitCost ?? null,
      destination_branch_id: params.destinationBranchId ?? null,
      reason: params.reason ?? null,
      notes: params.notes ?? null,
      created_by: params.createdBy,
    },
  });

  return { movement, quantityBefore, quantityAfter };
}
