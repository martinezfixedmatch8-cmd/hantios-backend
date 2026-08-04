import type { Prisma } from "@prisma/client";

// Session 2A -- deliberately named "Invoice Payment Status" (never
// "PaymentStatus" alone) and kept as a separate, purely-derived concept
// from purchase_orders.payment_status -- that field already exists, is
// stored, and is written directly by Session B's settlement-payment path
// (recordPurchaseOrderPayment); it only knows about settlement payments
// against total_expected_value, nothing about advance payments or
// invoices. Confirmed with you before building rather than silently
// colliding the two. Session 2B extends this same type/function pair with
// the remaining 3 states (FULLY_PAID/OVERDUE/CANCELLED) once Commercial
// Invoice and settlement-payment awareness are both in scope; 2A only ever
// returns the first 3.
export type InvoicePaymentStatus = "UNPAID" | "PARTIALLY_PAID" | "FULLY_PREPAID";

// Pure, JS-only derivation -- mirrors computeNegotiationStatus's own shape
// (no list/filter endpoint needs this at the DB layer this session, only a
// single-invoice read). Never stored.
export function computeProformaPaymentStatus(proformaTotal: Prisma.Decimal, advancePaidSum: Prisma.Decimal): InvoicePaymentStatus {
  if (advancePaidSum.lessThanOrEqualTo(0)) return "UNPAID";
  if (advancePaidSum.greaterThanOrEqualTo(proformaTotal)) return "FULLY_PREPAID";
  return "PARTIALLY_PAID";
}
