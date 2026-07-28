import { Prisma } from "@prisma/client";

// Pure classification/decision functions plus the one shared, DB-touching
// helper every hook site (Sale creation, Sale Void restoration, stock-
// adjustment) calls identically, rather than each re-deriving the same
// logic. The actual notification-sending/recipient-query/audit-logging work
// lives in stockAlertSubscriber.ts, not here -- this file only decides
// WHETHER something crossed a debounce boundary and atomically persists that
// decision; publishing and delivery are the caller's/subscriber's job.

export type StockSeverity = "low" | "critical" | "out_of_stock";

// Priority order matters -- the three conditions overlap (critical implies
// low, out_of_stock implies both), so this is evaluated most-severe-first,
// not as independent, mutually-exclusive bands.
export function classifyStockSeverity(quantity: Prisma.Decimal, minStockLevel: Prisma.Decimal): StockSeverity | null {
  if (quantity.lessThanOrEqualTo(0)) return "out_of_stock";
  if (quantity.lessThanOrEqualTo(minStockLevel.dividedBy(2))) return "critical";
  if (quantity.lessThanOrEqualTo(minStockLevel)) return "low";
  return null; // above threshold -- not low
}

export type StockAlertTransition = "entered" | "recovered" | null;

// The debounce decision, in one place, shared by every hook site instead of
// re-derived three times. Severity ESCALATING within an already-active
// episode (low -> critical) is deliberately NOT a transition -- exactly one
// notification per episode, per the locked requirement.
//
// `direction` gates "entered" as a hard invariant, not an assumption: an
// increase must NEVER be reported as newly entering a low-stock episode, per
// the locked requirement. Severity is normally monotonic in quantity, so an
// increase producing "entered" should be impossible on its own -- but that
// assumption silently breaks if `minStockLevel` itself changes between the
// debounce being set and being re-evaluated (e.g. PATCH /products/:id
// raising minStockLevel after a row has gone stale-inactive above the old
// threshold), which nothing else in this file or its callers guards against.
// QA reproduced this live: a plain increase illegally fired StockLow once
// minStockLevel was raised mid-episode. Enforcing the gate here, rather than
// trusting the monotonicity argument, closes that gap regardless of cause.
export function evaluateStockAlertTransition(
  wasActive: boolean,
  severity: StockSeverity | null,
  direction: "increase" | "decrease"
): StockAlertTransition {
  if (!wasActive && severity !== null) return direction === "increase" ? null : "entered";
  if (wasActive && severity === null) return "recovered";
  return null;
}

// Defined here (not in events.ts) so events.ts can import it -- keeps the
// dependency direction one-way (events.ts depends on this file, never the
// reverse), avoiding a circular import between the two.
export interface StockAlertPayload {
  businessId: string;
  branchId: string;
  productId: string;
  currentQuantity: string;
  minStockLevel: string;
  severity: StockSeverity | null;
  occurredAt: string;
}

export type PendingStockAlertEvent =
  | { name: "StockLow"; payload: StockAlertPayload & { severity: StockSeverity } }
  | { name: "StockRecovered"; payload: StockAlertPayload & { severity: null } };

// Shared by createSale's decrement loop, voidSale's restoration, and
// adjustProductStock (both directions) -- evaluates whether THIS quantity
// change crosses the debounced low-stock threshold, atomically updates
// branch_inventory's debounce fields in the SAME transaction as the quantity
// change (never a separate, racy write), and returns the event to publish
// after commit, if any. Returns null when min_stock_level isn't configured
// (nothing to check) or the change didn't cross a debounce boundary.
export async function applyStockAlertTransition(
  tx: Prisma.TransactionClient,
  params: {
    businessId: string;
    branchId: string;
    productId: string;
    branchInventoryId: string;
    wasActive: boolean;
    minStockLevel: Prisma.Decimal | null;
    quantityAfter: Prisma.Decimal;
    direction: "increase" | "decrease";
  }
): Promise<PendingStockAlertEvent | null> {
  if (params.minStockLevel === null) return null;

  const severity = classifyStockSeverity(params.quantityAfter, params.minStockLevel);
  const transition = evaluateStockAlertTransition(params.wasActive, severity, params.direction);
  if (!transition) return null;

  await tx.branch_inventory.update({
    where: { id: params.branchInventoryId },
    data:
      transition === "entered"
        ? { low_stock_alert_active: true, low_stock_alerted_at: new Date() }
        : { low_stock_alert_active: false, low_stock_alerted_at: null },
  });

  const basePayload = {
    businessId: params.businessId,
    branchId: params.branchId,
    productId: params.productId,
    currentQuantity: params.quantityAfter.toString(),
    minStockLevel: params.minStockLevel.toString(),
    occurredAt: new Date().toISOString(),
  };

  return transition === "entered"
    ? { name: "StockLow", payload: { ...basePayload, severity: severity! } }
    : { name: "StockRecovered", payload: { ...basePayload, severity: null } };
}
