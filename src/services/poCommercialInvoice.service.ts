import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { getNextCommercialInvoiceNumber } from "../lib/commercialInvoiceNumber";
import { computeProformaPaymentStatus, computeFullPaymentStatus } from "../lib/invoicePaymentStatus";
import type { SupersedeCommercialInvoiceInput, ListCommercialInvoicesQuery } from "../validation/poCommercialInvoice.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

const COMMERCIAL_INVOICE_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

export function issueCommercialInvoiceEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/commercial-invoices`;
}
export function supersedeCommercialInvoiceEndpoint(poId: string, invoiceId: string): string {
  return `POST /purchase-orders/${poId}/commercial-invoices/${invoiceId}/supersede`;
}

// Loads the PO's current (status=issued) Proforma Invoice and computes its
// own Payment Status -- the shared gate-check both issue and the
// payment-status read use.
async function loadGatingProformaStatus(poId: string) {
  const proforma = await prisma.po_proforma_invoices.findFirst({
    where: { purchase_order_id: poId, status: "issued" },
    orderBy: { issued_at: "desc" },
  });
  if (!proforma) return { proforma: null, status: "UNPAID" as const, advancePaidSum: new Prisma.Decimal(0) };

  const advancePayments = await prisma.po_advance_payments.findMany({
    where: { proforma_invoice_id: proforma.id },
    select: { amount: true },
  });
  const advancePaidSum = advancePayments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
  const status = computeProformaPaymentStatus(proforma.total, advancePaidSum);
  return { proforma, status, advancePaidSum };
}

// Interim "post-shipment" gate substitute -- the original design says
// Commercial Invoice is issuable "post-shipment," but Shipments (Session 3)
// doesn't exist yet, so no real shipment-status gate is achievable this
// session. Using "the Proforma Invoice has been fully covered by advance
// payments" as the best available signal instead.
// TODO(Session 3): replace this gate with a real shipment-received/
// delivered status check once Shipments exists.
export async function issueCommercialInvoice(poId: string, actor: Actor, idempotencyKey: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");

  const { proforma, status } = await loadGatingProformaStatus(poId);
  if (!proforma) {
    throw badRequest("A Proforma Invoice must be issued and fully covered by advance payments before a Commercial Invoice can be issued");
  }
  if (status !== "FULLY_PREPAID") {
    throw badRequest(
      `Cannot issue a Commercial Invoice until the Proforma Invoice is fully covered by advance payments (current status: ${status})`
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, issueCommercialInvoiceEndpoint(poId));

    // Only one current (issued) Commercial Invoice per PO -- same
    // one-active-thing-at-a-time pattern as Proforma Invoice/Secure Link.
    await tx.po_commercial_invoices.updateMany({
      where: { purchase_order_id: poId, business_id: actor.businessId, status: "issued" },
      data: { status: "superseded" },
    });

    const invoiceNumber = await getNextCommercialInvoiceNumber(tx, actor.businessId);

    const created = await tx.po_commercial_invoices.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        invoice_number: invoiceNumber,
        // Server-derived, never client-suppliable on the normal issuance
        // path -- the exact figure that was just verified as fully
        // covered, keeping the gate airtight.
        total_amount: proforma.total,
        currency_code: proforma.currency_code,
        issued_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.commercial_invoice_issued",
      entityType: "po_commercial_invoice",
      entityId: created.id,
      reason: `Commercial Invoice ${invoiceNumber} issued for PO ${po.po_number}, total ${created.total_amount.toString()} ${created.currency_code}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, issueCommercialInvoiceEndpoint(poId), 201, responseBody);
    return created;
  }, COMMERCIAL_INVOICE_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderCommercialInvoiceIssued", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    commercialInvoiceId: result.id,
    totalAmount: result.total_amount.toString(),
  });

  return result;
}

// The one place a human can adjust the figure -- an explicit, reasoned
// correction. Immutable-document rule preserved: never an in-place PATCH,
// always a new row with supersedes_id pointing back.
export async function supersedeCommercialInvoice(
  poId: string,
  invoiceId: string,
  input: SupersedeCommercialInvoiceInput,
  actor: Actor,
  idempotencyKey: string
) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  const existing = await getOwned(prisma.po_commercial_invoices.findUnique({ where: { id: invoiceId } }), actor.businessId, "Commercial invoice");
  if (existing.purchase_order_id !== poId) throw notFound("Commercial invoice not found");
  if (existing.status !== "issued") {
    throw badRequest("Only the current (issued) Commercial Invoice can be superseded -- it may have already been corrected");
  }

  const totalAmount = new Prisma.Decimal(input.totalAmount);

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, supersedeCommercialInvoiceEndpoint(poId, invoiceId));

    const guarded = await tx.po_commercial_invoices.updateMany({
      where: { id: invoiceId, business_id: actor.businessId, status: "issued" },
      data: { status: "superseded" },
    });
    if (guarded.count === 0) {
      throw badRequest("Commercial invoice was modified concurrently -- please retry");
    }

    const invoiceNumber = await getNextCommercialInvoiceNumber(tx, actor.businessId);

    const created = await tx.po_commercial_invoices.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        invoice_number: invoiceNumber,
        total_amount: totalAmount,
        currency_code: existing.currency_code,
        issued_by: actor.userId,
        supersedes_id: existing.id,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.commercial_invoice_superseded",
      entityType: "po_commercial_invoice",
      entityId: created.id,
      reason: `Commercial Invoice ${invoiceNumber} supersedes ${existing.invoice_number} on PO ${po.po_number}: ${input.reason}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, supersedeCommercialInvoiceEndpoint(poId, invoiceId), 201, responseBody);
    return created;
  }, COMMERCIAL_INVOICE_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderCommercialInvoiceSuperseded", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    commercialInvoiceId: result.id,
    supersedesId: existing.id,
  });

  return result;
}

export async function listCommercialInvoices(poId: string, query: ListCommercialInvoicesQuery, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");

  const resolved = resolveListQuery(query, { sortableFields: ["issued_at"] as const, defaultSort: "issued_at" as const });
  const where = { business_id: businessId, purchase_order_id: poId };
  const [rows, total] = await Promise.all([
    prisma.po_commercial_invoices.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.po_commercial_invoices.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

// GET /purchase-orders/:poId/payment-status -- the full derived enum +
// supporting figures (amount paid, amount owed, due date if applicable).
// Single shared implementation: this is the only caller of
// computeFullPaymentStatus in the owner-side API surface.
export async function getPaymentStatus(poId: string, businessId: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");

  const currentCommercialInvoice = await prisma.po_commercial_invoices.findFirst({
    where: { purchase_order_id: poId, status: "issued" },
    orderBy: { issued_at: "desc" },
  });

  const { proforma, advancePaidSum } = await loadGatingProformaStatus(poId);

  const settlementPayments = await prisma.purchase_order_payments.findMany({
    where: { purchase_order_id: poId },
    select: { amount: true },
  });
  const settlementPaidSum = settlementPayments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));

  const status = computeFullPaymentStatus({
    poStatus: po.status,
    paymentTerms: po.payment_terms,
    commercialInvoice: currentCommercialInvoice ? { totalAmount: currentCommercialInvoice.total_amount, issuedAt: currentCommercialInvoice.issued_at } : null,
    proformaTotal: proforma?.total ?? null,
    advancePaidSum,
    settlementPaidSum,
    now: new Date(),
  });

  const totalPaid = advancePaidSum.plus(settlementPaidSum);
  const referenceTotal = currentCommercialInvoice?.total_amount ?? proforma?.total ?? null;
  const dueDate =
    currentCommercialInvoice && po.payment_terms && ["net_30", "net_60", "net_90"].includes(po.payment_terms)
      ? new Date(currentCommercialInvoice.issued_at.getTime() + { net_30: 30, net_60: 60, net_90: 90 }[po.payment_terms as "net_30" | "net_60" | "net_90"] * 24 * 60 * 60 * 1000)
      : null;

  return {
    status,
    paymentTerms: po.payment_terms,
    currentCommercialInvoice,
    currentProformaInvoice: proforma,
    amountPaid: totalPaid.toString(),
    amountOwed: referenceTotal ? referenceTotal.minus(totalPaid).toString() : null,
    dueDate,
  };
}
