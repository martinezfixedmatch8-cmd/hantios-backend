import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict, notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import type { RecordAdvancePaymentInput, ListAdvancePaymentsQuery } from "../validation/poAdvancePayment.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

const ADVANCE_PAYMENT_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

export function recordAdvancePaymentEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/advance-payments`;
}

// THE CORE ACCOUNTING-CORRECTNESS RULE THIS MODULE EXISTS TO ENFORCE:
// recording an advance payment NEVER creates an Expense record. Advance
// payments represent a Current Asset (prepayment to a supplier for goods
// not yet received), not an operating expense -- that's Session B's
// settlement-payment path (purchase_order_payments, via
// createExpenseInTransaction), a completely separate table and a
// completely separate transaction, never touched from here.
export async function recordAdvancePayment(poId: string, input: RecordAdvancePaymentInput, actor: Actor, idempotencyKey: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");

  const invoice = await getOwned(
    prisma.po_proforma_invoices.findUnique({ where: { id: input.proformaInvoiceId } }),
    actor.businessId,
    "Proforma invoice"
  );
  if (invoice.purchase_order_id !== poId) throw notFound("Proforma invoice not found");
  if (invoice.status !== "issued") {
    throw badRequest("Cannot record an advance payment against a superseded proforma invoice");
  }

  const instruction = await getOwned(
    prisma.supplier_payment_instructions.findUnique({ where: { id: input.supplierPaymentInstructionId } }),
    actor.businessId,
    "Payment instruction"
  );
  // A payment instruction belongs to a specific supplier -- it must be the
  // SAME supplier this PO was placed with, not merely any supplier in the
  // same business. Without this check, an advance payment could be routed
  // to an unrelated supplier's bank/wallet details.
  if (instruction.supplier_id !== po.supplier_id) {
    throw badRequest("Payment instruction does not belong to this purchase order's supplier");
  }

  if (input.paymentMethodId) {
    const method = await getOwned(prisma.payment_methods.findUnique({ where: { id: input.paymentMethodId } }), actor.businessId, "Payment method");
    if (method.status !== "active") throw badRequest("Cannot record a payment against an archived payment method");
  }

  const amount = new Prisma.Decimal(input.amount);

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, recordAdvancePaymentEndpoint(poId));

    // HNT2-PO-001 fix -- the overpayment cap check used to read
    // existingPayments and compare against invoice.total BEFORE this
    // transaction began, so two concurrent requests could both read the
    // same paidSoFar, both pass the cap check, and both commit, jointly
    // exceeding the proforma invoice's own total. Fixed by locking the
    // Proforma Invoice row for the duration of this transaction -- a
    // standard Postgres row lock, the same technique already proven under
    // real concurrency elsewhere in this repo (Sale Refund's own row lock
    // on the original sale) -- so a second concurrent request against the
    // SAME invoice blocks here until the first commits or rolls back, and
    // then re-sums against the now-committed history, never a stale
    // pre-transaction read. "Non-reversed" per the audit's own wording is
    // not yet a real distinction -- po_advance_payments has no reversal
    // concept yet (that's Batch 4 / HNT2-PO-002's own future work, which
    // explicitly depends on this fix being merged first) -- so every
    // existing row for this invoice is summed as-is; once a reversal
    // column exists, this query is the one place that needs to also
    // exclude reversed rows.
    await tx.$queryRaw`SELECT id FROM po_proforma_invoices WHERE id = ${input.proformaInvoiceId} FOR UPDATE`;

    const existingPayments = await tx.po_advance_payments.findMany({
      where: { proforma_invoice_id: input.proformaInvoiceId },
      select: { amount: true },
    });
    const paidSoFar = existingPayments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
    const newTotal = paidSoFar.plus(amount);
    if (newTotal.greaterThan(invoice.total)) {
      // A deterministic 409, not 400 -- this is a genuine state conflict
      // (what's actually still available on the invoice, re-checked under
      // lock), not a static validation error about the request's own shape.
      throw conflict(
        `Advance payment of ${amount.toString()} would bring total advance payments to ${newTotal.toString()}, exceeding the proforma invoice total of ${invoice.total.toString()} -- ${paidSoFar.toString()} is already recorded`
      );
    }

    // Snapshot the instruction's details at time of payment -- instructions
    // can change later, this payment record must not.
    const created = await tx.po_advance_payments.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        proforma_invoice_id: input.proformaInvoiceId,
        amount,
        currency_code: input.currency,
        exchange_rate_snapshot: input.exchangeRateSnapshot,
        base_currency: input.baseCurrency,
        supplier_currency: input.supplierCurrency,
        payment_method_id: input.paymentMethodId,
        supplier_payment_instruction_id: instruction.id,
        beneficiary_name_snapshot: instruction.beneficiary_name,
        bank_name_snapshot: instruction.bank_name,
        account_number_snapshot: instruction.account_number,
        iban_snapshot: instruction.iban,
        swift_snapshot: instruction.swift,
        wallet_address_snapshot: instruction.wallet_address,
        network_snapshot: instruction.network,
        reference: input.reference,
        installment_label: input.installmentLabel,
        ...(input.paidAt ? { paid_at: input.paidAt } : {}),
        recorded_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.advance_payment_recorded",
      entityType: "po_advance_payment",
      entityId: created.id,
      reason: `Advance payment of ${amount.toString()} ${created.currency_code} recorded against proforma invoice ${invoice.invoice_number} for PO ${po.po_number}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, recordAdvancePaymentEndpoint(poId), 201, responseBody);
    return created;
  }, ADVANCE_PAYMENT_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderAdvancePaymentRecorded", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    proformaInvoiceId: input.proformaInvoiceId,
    advancePaymentId: result.id,
    amount: amount.toString(),
  });

  return result;
}

export async function listAdvancePayments(poId: string, query: ListAdvancePaymentsQuery, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");

  const resolved = resolveListQuery(query, { sortableFields: ["paid_at"] as const, defaultSort: "paid_at" as const });
  const where = { business_id: businessId, purchase_order_id: poId };
  const [rows, total] = await Promise.all([
    prisma.po_advance_payments.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.po_advance_payments.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}
