import { Prisma, type PaymentTerms } from "@prisma/client";

// Session 2A -- deliberately named "Invoice Payment Status" (never
// "PaymentStatus" alone) and kept as a separate, purely-derived concept
// from purchase_orders.payment_status -- that field already exists, is
// stored, and is written directly by Session B's settlement-payment path
// (recordPurchaseOrderPayment); it only knows about settlement payments
// against total_expected_value, nothing about advance payments or
// invoices. Confirmed with you before building rather than silently
// colliding the two.
export type InvoicePaymentStatus = "UNPAID" | "PARTIALLY_PAID" | "FULLY_PREPAID";

// Pure, JS-only derivation -- mirrors computeNegotiationStatus's own shape
// (no list/filter endpoint needs this at the DB layer, only a single-
// invoice read). Never stored. Scoped to the Proforma Invoice, used before
// a Commercial Invoice exists (or when one never will, for a PO that stays
// on advance payments alone).
export function computeProformaPaymentStatus(proformaTotal: Prisma.Decimal, advancePaidSum: Prisma.Decimal): InvoicePaymentStatus {
  if (advancePaidSum.lessThanOrEqualTo(0)) return "UNPAID";
  if (advancePaidSum.greaterThanOrEqualTo(proformaTotal)) return "FULLY_PREPAID";
  return "PARTIALLY_PAID";
}

// Session 2B -- completes the derived enum. FULLY_PREPAID is deliberately
// NOT a reachable outcome here: once a Commercial Invoice exists, its own
// total_amount (not the Proforma's) is the authoritative figure being
// measured against, and "fully covered" against a real Commercial Invoice
// is expressed as FULLY_PAID instead -- the two concepts describe the same
// underlying fact (fully covered) at two different stages of the deal, so
// only one of them is ever the live answer at a time.
export type FullInvoicePaymentStatus = InvoicePaymentStatus | "FULLY_PAID" | "OVERDUE" | "CANCELLED";

// Anchor + term lengths for the OVERDUE due-date calculation -- a fresh
// decision, not verified against a pre-existing rule, since no due-date
// concept existed anywhere in this codebase before this session (Debts'
// own date_due is a directly-set field, not derived from an issue date +
// term). Chosen exactly as the spec's own suggested default: Commercial
// Invoice issuedAt + term days. Flagged for confirmation, not silently
// assumed to be the one true business rule.
const PAYMENT_TERM_DAYS: Partial<Record<PaymentTerms, number>> = {
  net_30: 30,
  net_60: 60,
  net_90: 90,
};

export interface FullPaymentStatusInput {
  poStatus: string;
  paymentTerms: PaymentTerms | null;
  commercialInvoice: { totalAmount: Prisma.Decimal; issuedAt: Date } | null;
  proformaTotal: Prisma.Decimal | null;
  advancePaidSum: Prisma.Decimal;
  settlementPaidSum: Prisma.Decimal;
  now: Date;
}

// Combines po_advance_payments (2A) AND purchase_order_payments (Session B
// settlement payments) against whichever total is currently authoritative --
// the Proforma's before a Commercial Invoice exists, the Commercial
// Invoice's own total_amount once one does. Same derivation pattern as
// Negotiation Status and Debt aging buckets -- a pure JS function here
// (mirrors computeNegotiationStatus's own shape), not a scheduler-
// maintained column. The one function every 2A and 2B caller shares --
// nothing duplicates this logic.
export function computeFullPaymentStatus(input: FullPaymentStatusInput): FullInvoicePaymentStatus {
  if (input.poStatus === "cancelled") return "CANCELLED";

  if (!input.commercialInvoice) {
    if (!input.proformaTotal) return "UNPAID";
    return computeProformaPaymentStatus(input.proformaTotal, input.advancePaidSum);
  }

  const totalPaid = input.advancePaidSum.plus(input.settlementPaidSum);
  if (totalPaid.greaterThanOrEqualTo(input.commercialInvoice.totalAmount)) return "FULLY_PAID";

  // OVERDUE only ever fires for NET_30/60/90 terms -- a PREPAYMENT-terms PO
  // has no due-date concept (payment was always due up front), so it can
  // only ever be UNPAID/PARTIALLY_PAID/FULLY_PAID, never OVERDUE.
  const termDays = input.paymentTerms ? PAYMENT_TERM_DAYS[input.paymentTerms] : undefined;
  if (termDays !== undefined) {
    const dueDate = new Date(input.commercialInvoice.issuedAt.getTime() + termDays * 24 * 60 * 60 * 1000);
    if (input.now.getTime() > dueDate.getTime()) return "OVERDUE";
  }

  if (totalPaid.greaterThan(0)) return "PARTIALLY_PAID";
  return "UNPAID";
}
