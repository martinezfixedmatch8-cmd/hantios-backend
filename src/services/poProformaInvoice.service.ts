import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { getNextProformaInvoiceNumber } from "../lib/proformaInvoiceNumber";
import { computeProformaPaymentStatus } from "../lib/invoicePaymentStatus";
import type { IssueProformaInvoiceInput, ListProformaInvoicesQuery } from "../validation/poProformaInvoice.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Same Neon-latency reasoning as every other transactional service in this
// repo -- this transaction does a counter allocation + a possible
// prior-invoice supersede + the new invoice insert + audit + idempotency.
const PROFORMA_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

// A PO must actually be SENT (or further along) before its terms are real
// enough to invoice -- mirrors recordPurchaseOrderPayment's own
// PAYABLE_PO_STATUSES bar exactly (a DRAFT PO's terms aren't final yet, a
// CANCELLED one has none to invoice).
const INVOICEABLE_PO_STATUSES = ["sent", "confirmed", "partially_received", "received"] as const;
type InvoiceablePoStatus = (typeof INVOICEABLE_PO_STATUSES)[number];

export function issueProformaInvoiceEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/proforma-invoices`;
}

// Generated from the latest Agreement Snapshot when one exists (Enhancement
// #5's own immutable per-round record) -- flagged interpretation, not
// silently assumed: a PO that never entered negotiation (the common case,
// going straight DRAFT->SENT->CONFIRMED with no supplier counter-offer) has
// zero Agreement Snapshot rows. Rather than block Proforma Invoice
// generation entirely for that common case, this falls back to the PO's
// own current line items/total_expected_value directly -- a PO the
// supplier never countered is trivially "agreed" as sent.
export async function issueProformaInvoice(poId: string, input: IssueProformaInvoiceInput, actor: Actor, idempotencyKey: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  if (!INVOICEABLE_PO_STATUSES.includes(po.status as InvoiceablePoStatus)) {
    throw badRequest(`Purchase order status "${po.status}" cannot be invoiced (must be sent, confirmed, partially_received, or received)`);
  }

  const validUntil = new Date(input.validUntil);
  if (validUntil.getTime() <= Date.now()) {
    throw badRequest("validUntil must be a future date");
  }

  const latestSnapshot = await prisma.po_negotiation_agreement_snapshots.findFirst({
    where: { purchase_order_id: poId },
    orderBy: { negotiation_round: "desc" },
  });
  const subtotal = latestSnapshot ? latestSnapshot.total_expected_value : po.total_expected_value;

  const shippingCost = new Prisma.Decimal(input.shippingCost);
  const insurance = new Prisma.Decimal(input.insurance);
  const total = subtotal.plus(shippingCost).plus(insurance);

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, issueProformaInvoiceEndpoint(poId));

    // One active-thing-at-a-time -- same pattern as Secure Link's own
    // regenerate-revokes-prior shape. Issuing a new Proforma Invoice for
    // this PO supersedes whatever was previously `issued`.
    await tx.po_proforma_invoices.updateMany({
      where: { purchase_order_id: poId, business_id: actor.businessId, status: "issued" },
      data: { status: "superseded" },
    });

    const invoiceNumber = await getNextProformaInvoiceNumber(tx, actor.businessId);

    const created = await tx.po_proforma_invoices.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        agreement_snapshot_id: latestSnapshot?.id ?? null,
        invoice_number: invoiceNumber,
        subtotal,
        shipping_cost: shippingCost,
        insurance,
        total,
        currency_code: po.currency_code,
        valid_until: validUntil,
        issued_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.proforma_invoice_issued",
      entityType: "po_proforma_invoice",
      entityId: created.id,
      reason: `Proforma Invoice ${invoiceNumber} issued for PO ${po.po_number}, total ${total.toString()} ${created.currency_code}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, issueProformaInvoiceEndpoint(poId), 201, responseBody);
    return created;
  }, PROFORMA_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderProformaInvoiceIssued", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    proformaInvoiceId: result.id,
    total: result.total.toString(),
  });

  return result;
}

export async function listProformaInvoices(poId: string, query: ListProformaInvoicesQuery, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");

  const resolved = resolveListQuery(query, { sortableFields: ["issued_at"] as const, defaultSort: "issued_at" as const });
  const where = { business_id: businessId, purchase_order_id: poId };
  const [rows, total] = await Promise.all([
    prisma.po_proforma_invoices.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.po_proforma_invoices.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

// Bundles the derived Invoice Payment Status + supporting figures directly
// onto the single-invoice read -- same "derived, never stored" rule as
// Negotiation Status, computed fresh on every call.
export async function getProformaInvoice(poId: string, invoiceId: string, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");
  const invoice = await getOwned(prisma.po_proforma_invoices.findUnique({ where: { id: invoiceId } }), businessId, "Proforma invoice");
  if (invoice.purchase_order_id !== poId) {
    throw notFound("Proforma invoice not found");
  }

  const advancePayments = await prisma.po_advance_payments.findMany({ where: { proforma_invoice_id: invoiceId } });
  const advancePaidSum = advancePayments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
  const paymentStatus = computeProformaPaymentStatus(invoice.total, advancePaidSum);

  return { ...invoice, paymentStatus, amountPaid: advancePaidSum.toString(), amountRemaining: invoice.total.minus(advancePaidSum).toString() };
}
