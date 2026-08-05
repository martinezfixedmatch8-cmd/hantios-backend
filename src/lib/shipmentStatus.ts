import type { Prisma } from "@prisma/client";
import type { ShipmentStatus, ShipmentCostResponsibility, Incoterm } from "@prisma/client";

// Addendum #13 -- derived, NEVER stored on purchase_orders. Same
// derive-don't-store philosophy already applied to Negotiation Status/Debt
// aging/Invoice Payment Status elsewhere in this codebase.
export type PoShippingStatus = "NO_SHIPMENT" | "PARTIALLY_SHIPPED" | "FULLY_SHIPPED";

export interface ItemShippedSummary {
  poItemId: string;
  quantityOrdered: Prisma.Decimal;
  quantityShipped: Prisma.Decimal;
}

// Pure, JS-only -- mirrors computeNegotiationStatus's own shape. Every PO
// line item must be considered (an item with zero shipped rows still needs
// to be represented in the input, quantityShipped = 0) so a PO with some
// lines fully shipped and others untouched correctly reads
// PARTIALLY_SHIPPED, not FULLY_SHIPPED.
export function computeShippingStatus(items: ItemShippedSummary[]): PoShippingStatus {
  const anyShipped = items.some((i) => i.quantityShipped.greaterThan(0));
  if (!anyShipped) return "NO_SHIPMENT";
  const fullyShipped = items.every((i) => i.quantityShipped.greaterThanOrEqualTo(i.quantityOrdered));
  return fullyShipped ? "FULLY_SHIPPED" : "PARTIALLY_SHIPPED";
}

// Base spec's own literal example, given for THREE representative terms
// (EXW->buyer, FOB/CIF/DAP->supplier) -- one from each Incoterm family
// besides E. Extended consistently: E-group (EXW, "buyer arranges
// everything") is the only "buyer" default; every other term (F/C/D
// groups) follows the given FOB/CIF/DAP pattern -> supplier. A deliberately
// simple, suggestion-only heuristic (real Incoterm rules have more nuance,
// e.g. F-group textbook is "buyer arranges main carriage") -- precision to
// the letter of ICC rules matters far less here than the given example,
// since this value is ALWAYS explicitly overridable, never authoritative.
export function suggestCostResponsibility(incoterm: Incoterm | null | undefined): ShipmentCostResponsibility | null {
  if (!incoterm) return null;
  return incoterm === "EXW" ? "buyer" : "supplier";
}

// Permissive state machine per the locked instruction ("block only clearly
// nonsensical backward jumps... real-world logistics reporting isn't
// always clean"). delivered/cancelled are terminal (addendum #23's version-
// lock is enforced at the guarded-updateMany layer, this map is the first
// line of defense with a clear error message). `delayed` is re-enterable
// into the forward flow from wherever it paused, matching the base spec's
// own choice to model delay as a status value rather than a boolean flag
// alongside status (see CLAUDE.md's own write-up for the reasoning).
export const SHIPMENT_STATUS_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  pending: ["dispatched", "delayed", "cancelled"],
  dispatched: ["in_transit", "customs", "arrived", "delayed", "cancelled"],
  in_transit: ["customs", "arrived", "delayed", "cancelled"],
  customs: ["arrived", "delayed", "cancelled"],
  arrived: ["delivered", "delayed", "cancelled"],
  delayed: ["dispatched", "in_transit", "customs", "arrived", "cancelled"],
  delivered: [],
  cancelled: [],
};

export const TERMINAL_SHIPMENT_STATUSES: ShipmentStatus[] = ["delivered", "cancelled"];

export function isValidShipmentTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  if (from === to) return false;
  return SHIPMENT_STATUS_TRANSITIONS[from].includes(to);
}
