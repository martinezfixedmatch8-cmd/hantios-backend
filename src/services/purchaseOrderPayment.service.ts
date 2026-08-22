import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { getCurrency } from "../lib/currencyReference";
import { createExpenseInTransaction } from "./expense.service";
import { ensureSystemCategoriesSeeded } from "./expenseCategory.service";
import { generateReceiptInTransaction, buildPoSettlementReceiptSnapshot } from "./receipt.service";
import type { RecordPurchaseOrderPaymentInput } from "../validation/purchaseOrderPayment.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Same Neon-latency reasoning as every other transactional service in this
// repo -- this transaction does a version-guarded PO update + a linked
// Expense creation (its own counter allocation + insert) + a payment ledger
// insert + audit log + idempotency completion, several sequential round
// trips deep.
const PO_PAYMENT_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

const PAYABLE_PO_STATUSES = ["sent", "confirmed", "partially_received", "received"] as const;
type PayablePoStatus = (typeof PAYABLE_PO_STATUSES)[number];

// Resolved via ensureSystemCategoriesSeeded + lookup by name -- see
// expenseCategory.service.ts's SYSTEM_CATEGORY_NAMES, extended this session
// specifically so this auto-created Expense has somewhere to live.
const INVENTORY_PURCHASES_CATEGORY_NAME = "Inventory Purchases";

export function recordPurchaseOrderPaymentEndpoint(purchaseOrderId: string): string {
  return `POST /purchase-orders/${purchaseOrderId}/payments`;
}

export async function recordPurchaseOrderPayment(
  purchaseOrderId: string,
  input: RecordPurchaseOrderPaymentInput,
  actor: Actor,
  idempotencyKey: string
) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: purchaseOrderId } }), actor.businessId, "Purchase order");
  // Fail-fast pre-checks only, same "nicer error for the common
  // non-concurrent case, real guard happens inside the transaction" shape
  // already established for PO's own PATCH-while-DRAFT elsewhere in this
  // module -- every one of these is re-verified for real, under a row
  // lock, inside the transaction below (HNT-PO-001 fix).
  if (!PAYABLE_PO_STATUSES.includes(po.status as PayablePoStatus)) {
    throw badRequest(
      `Purchase order status "${po.status}" cannot accept a payment (must be sent, confirmed, partially_received, or received)`
    );
  }

  const amount = new Prisma.Decimal(input.amount);
  if (amount.greaterThan(po.remaining_amount)) {
    throw badRequest(`Payment amount ${amount.toString()} exceeds the remaining balance of ${po.remaining_amount.toString()}`);
  }

  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  const currency = getCurrency(business.currency);

  // Declared here so the post-transaction domain-event publishing below
  // can read the FINAL, real values -- assigned only inside the
  // transaction, from state read under the lock, never from the
  // pre-transaction po/currentCommercialInvoice/grnItems reads above.
  let matchStatus: "matched" | "match_failed" = "matched";
  let matchVariance = new Prisma.Decimal(0);

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, recordPurchaseOrderPaymentEndpoint(purchaseOrderId));

    // HNT-PO-001 fix -- a Commercial Invoice supersede or a new GRN could
    // previously commit between this endpoint's own pre-transaction reads
    // and its atomic PO update, letting a payment be accepted against a
    // stale invoice total or stale received-value. Fixed by locking the PO
    // row for the duration of this transaction (the real serialization
    // point every one of those other writers also touches) and re-reading
    // EVERYTHING the 3-way match depends on fresh, under that lock -- never
    // a pre-transaction snapshot. supersedeCommercialInvoice now also
    // advances this same PO's own version on every supersede (belt-and-
    // suspenders alongside this re-read, not a replacement for it).
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${purchaseOrderId} FOR UPDATE`;

    const lockedPo = await tx.purchase_orders.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    if (!PAYABLE_PO_STATUSES.includes(lockedPo.status as PayablePoStatus)) {
      throw conflict(`Purchase order status "${lockedPo.status}" can no longer accept a payment -- it changed concurrently, please retry`);
    }
    if (amount.greaterThan(lockedPo.remaining_amount)) {
      throw conflict(
        `Payment amount ${amount.toString()} exceeds the remaining balance of ${lockedPo.remaining_amount.toString()} -- the remaining balance changed concurrently, please retry`
      );
    }

    // Session 2B re-pointing: when a current (issued) Commercial Invoice
    // exists for this PO, ITS total_amount is the authoritative match input,
    // never a client-supplied number -- keeps the match honest against a
    // real, previously-verified invoice instead of whatever a caller happens
    // to type. Falls back to the client-supplied invoiceAmount only when no
    // Commercial Invoice exists yet, byte-identical to Session B's original
    // behavior (every PO that hasn't reached that stage, including every
    // pre-existing Session B test). Read fresh, under the lock above.
    const currentCommercialInvoice = await tx.po_commercial_invoices.findFirst({
      where: { purchase_order_id: purchaseOrderId, status: "issued" },
      orderBy: { issued_at: "desc" },
    });
    let invoiceAmount: Prisma.Decimal;
    let invoiceReference: string | null;
    if (currentCommercialInvoice) {
      invoiceAmount = currentCommercialInvoice.total_amount;
      invoiceReference = input.invoiceReference ?? currentCommercialInvoice.invoice_number;
    } else {
      if (input.invoiceAmount === undefined) {
        throw badRequest("invoiceAmount is required when no Commercial Invoice has been issued for this purchase order");
      }
      invoiceAmount = new Prisma.Decimal(input.invoiceAmount);
      invoiceReference = input.invoiceReference ?? null;
    }

    // 3-way match: PO expected value vs supplier invoice vs cumulative
    // GRN-received value -- LOCKED tolerance = min(1% of expected, $10),
    // hardcoded, not a Business Settings field this session. aggregate() can't
    // multiply two columns, so the cumulative received VALUE is computed via
    // a manual reduce over the raw rows rather than a DB-side SUM. Read
    // fresh, under the lock above -- never a pre-transaction snapshot.
    const grnItems = await tx.goods_received_items.findMany({
      where: { purchase_order_items: { purchase_order_id: purchaseOrderId } },
      select: { quantity_received: true, unit_cost_actual: true },
    });
    const grnReceivedValue = grnItems.reduce(
      (sum, item) => sum.plus(item.quantity_received.times(item.unit_cost_actual)),
      new Prisma.Decimal(0)
    );

    const expectedValue = lockedPo.total_expected_value;
    const tolerance = Prisma.Decimal.min(expectedValue.times(0.01), new Prisma.Decimal(10));
    const invoiceVariance = invoiceAmount.minus(expectedValue).abs();
    const grnVariance = grnReceivedValue.minus(expectedValue).abs();
    matchVariance = Prisma.Decimal.max(invoiceVariance, grnVariance);
    matchStatus = matchVariance.lessThanOrEqualTo(tolerance) ? "matched" : "match_failed";

    if (matchStatus === "match_failed" && !input.matchOverride) {
      throw badRequest("Three-way match failed", {
        matchStatus,
        matchVariance: matchVariance.toString(),
        tolerance: tolerance.toString(),
        invoiceAmount: invoiceAmount.toString(),
        expectedValue: expectedValue.toString(),
        grnReceivedValue: grnReceivedValue.toString(),
      });
    }

    const newPaidAmount = lockedPo.paid_amount.plus(amount);
    const newRemainingAmount = lockedPo.remaining_amount.minus(amount);
    const newPaymentStatus = newRemainingAmount.isZero() ? "paid" : newPaidAmount.greaterThan(0) ? "partially_paid" : "unpaid";

    const updateResult = await tx.purchase_orders.updateMany({
      where: { id: purchaseOrderId, business_id: actor.businessId, version: input.version, status: { in: [...PAYABLE_PO_STATUSES] } },
      data: { paid_amount: newPaidAmount, remaining_amount: newRemainingAmount, payment_status: newPaymentStatus, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Purchase order was modified concurrently, or is no longer payable -- please retry with the latest version");
    }

    // Distinct GRN numbers received against this PO so far, comma-joined --
    // a payment is PO-scoped, not GRN-scoped, so there's no single GRN to
    // name (see prisma/schema.prisma's own comment on expenses.grn_number).
    const grns = await tx.goods_received_notes.findMany({ where: { purchase_order_id: purchaseOrderId }, select: { grn_number: true } });
    const grnNumber = grns.length > 0 ? grns.map((g) => g.grn_number).join(", ") : null;

    await ensureSystemCategoriesSeeded(tx, actor.businessId);
    // Batch 6 (HNT2-EXP-001) narrowed expense_categories' own unique
    // constraint to active-only, removing the compound business_id_name
    // Prisma lookup key -- findFirstOrThrow is semantically equivalent
    // here since this always targets a system category (seeded just
    // above), which can never be deactivated, so exactly one row can ever
    // match.
    const category = await tx.expense_categories.findFirstOrThrow({
      where: { business_id: actor.businessId, name: INVENTORY_PURCHASES_CATEGORY_NAME },
    });

    const now = new Date();
    const expense = await createExpenseInTransaction(tx, {
      businessId: actor.businessId,
      branchId: lockedPo.branch_id,
      scope: lockedPo.branch_id ? "branch" : "business",
      category: { id: category.id, name: category.name },
      amount,
      currencyCode: currency?.code ?? business.currency,
      currencySymbol: currency?.symbol ?? null,
      expenseDate: input.paymentDate,
      referenceNumber: invoiceReference,
      description: `Payment against Purchase Order ${lockedPo.po_number}`,
      notes: input.notes ?? null,
      source: "purchase_order",
      createdBy: actor.userId,
      purchaseOrderId,
      poNumber: lockedPo.po_number,
      grnNumber,
      // The payment recording IS the approval+paid event -- locked decision,
      // not an oversight (see createExpenseInTransaction's own comment).
      workflowOverride: { status: "paid", approvedBy: actor.userId, approvedAt: now, paidBy: actor.userId, paidAt: now },
      actorUserName: actor.userName,
      actorUserRole: actor.userRole,
    });

    // matchOverride is guaranteed defined here whenever matchStatus is
    // match_failed -- the earlier guard above already threw badRequest for
    // the only case where it wouldn't be.
    const payment = await tx.purchase_order_payments.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: purchaseOrderId,
        amount,
        invoice_amount: invoiceAmount,
        invoice_reference: invoiceReference,
        match_status: matchStatus,
        match_variance: matchVariance,
        match_overridden: matchStatus === "match_failed",
        match_override_reason: matchStatus === "match_failed" ? (input.matchOverride?.reason ?? null) : null,
        expense_id: expense.id,
        payment_date: input.paymentDate,
        notes: input.notes,
        created_by: actor.userId,
      },
    });

    // Module 06 (Receipt System) -- PO Settlement Receipt, the business's
    // own internal record of a payment made TO a supplier (distinct from
    // that supplier's own Commercial Invoice, which is the reverse
    // direction's document).
    const poSettlementReceipt = await generateReceiptInTransaction(tx, {
      businessId: actor.businessId,
      timezone: business.timezone,
      settings: business.settings,
      currencyCode: business.currency,
      receiptType: "po_settlement",
      source: { purchaseOrderPaymentId: payment.id },
      subtotal: amount,
      total: amount,
      snapshot: buildPoSettlementReceiptSnapshot(business, null, {
        supplierName: lockedPo.supplier_name_snapshot ?? "Unknown supplier",
        poNumber: lockedPo.po_number,
        matchStatus,
        amount: amount.toString(),
      }),
      createdBy: actor.userId,
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.payment_recorded",
      entityType: "purchase_order_payment",
      entityId: payment.id,
      reason: `Payment of ${amount.toString()} recorded against PO ${lockedPo.po_number} (match: ${matchStatus}${
        matchStatus === "match_failed" ? `, overridden: ${input.matchOverride?.reason}` : ""
      })`,
    });

    const updatedPo = await tx.purchase_orders.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    const responseBody = JSON.parse(JSON.stringify({ data: { payment, purchaseOrder: updatedPo, expense } })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, recordPurchaseOrderPaymentEndpoint(purchaseOrderId), 201, responseBody);

    return { payment, purchaseOrder: updatedPo, expense, poSettlementReceipt };
  }, PO_PAYMENT_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderPaymentRecorded", {
    businessId: actor.businessId,
    purchaseOrderId,
    paymentId: result.payment.id,
    amount: amount.toString(),
    matchStatus,
    paymentStatus: result.purchaseOrder.payment_status,
  });
  // Session 2B -- these did not exist before this session (confirmed via
  // Phase 0 grep on events.ts); added for real rather than re-fired.
  if (matchStatus === "matched") {
    domainEvents.publish("ThreeWayMatchPassed", {
      businessId: actor.businessId,
      purchaseOrderId,
      paymentId: result.payment.id,
      matchVariance: matchVariance.toString(),
    });
  } else {
    domainEvents.publish("ThreeWayMatchFailed", {
      businessId: actor.businessId,
      purchaseOrderId,
      paymentId: result.payment.id,
      matchVariance: matchVariance.toString(),
      overridden: true, // match_failed can only reach this point via an override, see the guard above
    });
  }
  // Fired for consistency -- a real Expense row now exists, same as every
  // other path that creates one.
  domainEvents.publish("ExpenseCreated", {
    expenseId: result.expense.id,
    businessId: actor.businessId,
    branchId: result.expense.branch_id,
    categoryId: result.expense.category_id,
    amount: amount.toString(),
  });
  domainEvents.publish("ReceiptGenerated", {
    businessId: actor.businessId,
    receiptId: result.poSettlementReceipt.id,
    receiptNumber: result.poSettlementReceipt.receipt_number,
    receiptType: result.poSettlementReceipt.receipt_type,
  });

  // poSettlementReceipt is internal-only (used above for the event payload)
  // -- never part of this endpoint's own public response contract, which
  // predates Module 06 and must stay byte-identical to before (a receipt is
  // fetched via GET /receipts/:id, not bundled here). Stripping it back out
  // is also what keeps the stored Idempotency-Key replay body (built inside
  // the transaction above, which never included it) consistent with this
  // live response -- a real regression this session's own full-suite run
  // caught via the pre-existing "replays the identical response" test.
  const { poSettlementReceipt: _receipt, ...publicResult } = result;
  return publicResult;
}
