import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict, notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { isOverdue } from "../lib/businessTime";
import { maskAdvancePaymentSnapshotFields } from "../lib/paymentInstructionMasking";
import type { RecordAdvancePaymentInput, ListAdvancePaymentsQuery, ReverseAdvancePaymentInput } from "../validation/poAdvancePayment.schema";

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
export function reverseAdvancePaymentEndpoint(poId: string, paymentId: string): string {
  return `POST /purchase-orders/${poId}/advance-payments/${paymentId}/reversals`;
}

// Batch 4 remediation (HNT2-PO-002) -- the ONE authoritative function for
// "how much of this proforma invoice's advance-payment total is still
// really outstanding, net of any reversals." Used by the overpayment cap
// check here AND by both Payment Status readers
// (poCommercialInvoice.service.ts's loadProformaPaymentStatus,
// poProformaInvoice.service.ts's own read) -- one function, three
// consumers, never duplicated math. Reversals' own negative delta_amount
// nets out directly via a plain sum, no special-casing needed.
export async function getEffectiveAdvancePaidSum(
  tx: Prisma.TransactionClient | PrismaClient,
  proformaInvoiceId: string
): Promise<Prisma.Decimal> {
  const payments = await tx.po_advance_payments.findMany({
    where: { proforma_invoice_id: proformaInvoiceId },
    select: { id: true, amount: true },
  });
  if (payments.length === 0) return new Prisma.Decimal(0);

  const reversals = await tx.po_advance_payment_reversals.findMany({
    where: { original_payment_id: { in: payments.map((p) => p.id) } },
    select: { delta_amount: true },
  });

  const paidSum = payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
  const reversedSum = reversals.reduce((sum, r) => sum.plus(r.delta_amount), new Prisma.Decimal(0)); // already negative
  return paidSum.plus(reversedSum);
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
  // Batch 4 remediation (HNT2-PO-003) -- only active instructions
  // selectable for new advance payments, in addition to every existing
  // check above.
  if (instruction.status !== "active") {
    throw badRequest(`Cannot record a payment against a ${instruction.status} payment instruction`);
  }
  if (instruction.expiry_date) {
    const business = await prisma.businesses.findUniqueOrThrow({
      where: { id: actor.businessId },
      select: { timezone: true, business_day_start_time: true },
    });
    // Business-local, inclusive-through semantics: valid THROUGH
    // expiry_date, invalid only once business-local "today" is strictly
    // after it. Reuses isOverdue's exact date-comparison technique
    // rather than inventing a second one -- see businessTime.ts's own
    // getBusinessMonthBounds comment for why @db.Date columns in this
    // schema are never compared via a timezone-shifted instant.
    if (isOverdue(instruction.expiry_date, business.timezone, business.business_day_start_time)) {
      throw badRequest("This payment instruction has expired");
    }
  }

  if (input.paymentMethodId) {
    const method = await getOwned(prisma.payment_methods.findUnique({ where: { id: input.paymentMethodId } }), actor.businessId, "Payment method");
    if (method.status !== "active") throw badRequest("Cannot record a payment against an archived payment method");
  }

  const amount = new Prisma.Decimal(input.amount);

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, recordAdvancePaymentEndpoint(poId));

    // HNT2-PO-001 fix (Batch 1) -- row lock on the Proforma Invoice,
    // serializing concurrent cap-check attempts against the same invoice.
    await tx.$queryRaw`SELECT id FROM po_proforma_invoices WHERE id = ${input.proformaInvoiceId} FOR UPDATE`;

    // Batch 4 remediation -- now goes through the one authoritative
    // function, which correctly excludes reversed amounts from the
    // running total, closing the gap Batch 1's own comment flagged.
    const paidSoFar = await getEffectiveAdvancePaidSum(tx, input.proformaInvoiceId);
    const newTotal = paidSoFar.plus(amount);
    if (newTotal.greaterThan(invoice.total)) {
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

    // Batch 4 remediation -- masked BEFORE the idempotency response body is
    // constructed, matching supplierPaymentInstruction.service.ts's own
    // create: the STORED idempotency response must never contain the
    // unmasked value at rest either, so a later replay never leaks it.
    // "The reveal endpoint is the only permitted full-value path" applies
    // uniformly, including to the creator's own response.
    const masked = { ...maskAdvancePaymentSnapshotFields(created), effectiveAmount: amount.toString() };
    const responseBody = JSON.parse(JSON.stringify({ data: masked })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, recordAdvancePaymentEndpoint(poId), 201, responseBody);
    return masked;
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
    prisma.po_advance_payments.findMany({
      where,
      orderBy: resolved.orderBy,
      skip: resolved.skip,
      take: resolved.take,
      include: { po_advance_payment_reversals: true },
    }),
    prisma.po_advance_payments.count({ where }),
  ]);

  // Batch 4 remediation -- requirement #7: expose original, reversed, and
  // effective amounts explicitly, so a caller can never mistake a
  // historical row's own `amount` for the current balance. Masked, same
  // "reveal endpoint is the only full-value path" rule as the creation
  // response above.
  const decorated = rows.map((row) => {
    const reversedAmount = row.po_advance_payment_reversals.reduce((sum, r) => sum.plus(r.delta_amount.abs()), new Prisma.Decimal(0));
    const effectiveAmount = row.amount.minus(reversedAmount);
    const { po_advance_payment_reversals, ...rest } = maskAdvancePaymentSnapshotFields(row);
    return { ...rest, reversals: po_advance_payment_reversals, reversedAmount: reversedAmount.toString(), effectiveAmount: effectiveAmount.toString() };
  });

  return paginate(decorated, total, query.page, query.pageSize);
}

// Batch 4 remediation (HNT2-PO-002) -- partial reversals allowed
// (confirmed policy): multiple append-only rows per original payment,
// cumulative bound enforced atomically. Reversal-of-a-reversal stays
// structurally impossible -- original_payment_id is a real composite FK
// typed to po_advance_payments only, a reversal row can never be the
// target of another reversal.
export async function reverseAdvancePayment(
  poId: string,
  paymentId: string,
  input: ReverseAdvancePaymentInput,
  actor: Actor,
  idempotencyKey: string
) {
  const payment = await getOwned(prisma.po_advance_payments.findUnique({ where: { id: paymentId } }), actor.businessId, "Advance payment");
  if (payment.purchase_order_id !== poId) throw notFound("Advance payment not found");

  const requestedAmount = new Prisma.Decimal(input.amount);

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, reverseAdvancePaymentEndpoint(poId, paymentId));

    // Atomic guard #1 -- version check + row lock in one statement.
    // business_id in the WHERE is defense-in-depth beyond getOwned's own
    // check above, per the confirmed review requirement.
    const guarded = await tx.po_advance_payments.updateMany({
      where: { id: paymentId, business_id: actor.businessId, version: input.version },
      data: { version: { increment: 1 } },
    });
    if (guarded.count === 0) {
      throw conflict("Advance payment was modified concurrently, please retry with the latest version");
    }

    // Atomic guard #2 -- re-sum reversals AFTER the version-guarded UPDATE
    // above has already taken the row lock, so a concurrent second
    // reversal attempt against the SAME payment is blocked here until this
    // transaction commits or rolls back, never interleaving between this
    // read and this transaction's own INSERT below.
    const existingReversals = await tx.po_advance_payment_reversals.findMany({
      where: { original_payment_id: paymentId },
      select: { delta_amount: true },
    });
    const alreadyReversed = existingReversals.reduce((sum, r) => sum.plus(r.delta_amount.abs()), new Prisma.Decimal(0));
    const remaining = payment.amount.minus(alreadyReversed);

    if (remaining.lessThanOrEqualTo(0)) {
      throw conflict("This advance payment has already been fully reversed");
    }
    if (requestedAmount.greaterThan(remaining)) {
      throw conflict(`Cannot reverse ${requestedAmount.toString()}; only ${remaining.toString()} remains reversible on this payment`);
    }

    const reversal = await tx.po_advance_payment_reversals.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        original_payment_id: paymentId,
        delta_amount: requestedAmount.negated(),
        reason: input.reason,
        created_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.advance_payment_reversed",
      entityType: "po_advance_payment",
      entityId: paymentId,
      reason: input.reason,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: reversal })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, reverseAdvancePaymentEndpoint(poId, paymentId), 201, responseBody);
    return reversal;
  }, ADVANCE_PAYMENT_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderAdvancePaymentReversed", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    advancePaymentId: paymentId,
    reversalId: result.id,
    amount: requestedAmount.toString(),
  });

  return result;
}

// Batch 4 remediation -- the advance-payment-side equivalent of
// supplierPaymentInstruction.service.ts's own revealSupplierPaymentInstruction:
// the ONLY code path that ever returns an unmasked payment snapshot. Same
// audit shape (one row per call, correlation id, fields revealed, never
// the full values themselves), same requirePermission gate at the route.
export async function revealAdvancePayment(poId: string, paymentId: string, actor: Actor) {
  const payment = await getOwned(prisma.po_advance_payments.findUnique({ where: { id: paymentId } }), actor.businessId, "Advance payment");
  if (payment.purchase_order_id !== poId) throw notFound("Advance payment not found");

  const correlationId = generateId();
  const fieldsRevealed = (["account_number_snapshot", "iban_snapshot", "swift_snapshot", "wallet_address_snapshot"] as const).filter(
    (field) => payment[field] !== null
  );

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "po_advance_payment.sensitive_data_revealed",
    entityType: "po_advance_payment",
    entityId: paymentId,
    reason: `Full advance payment snapshot details revealed for payment ${paymentId}`,
    correlationId,
    afterState: { permission: "reveal_payment_instruction", fieldsRevealed },
  });

  return payment;
}
