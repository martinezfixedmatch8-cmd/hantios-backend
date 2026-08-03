import { prisma } from "../lib/prisma";
import { getOwned } from "../lib/ownership";
import { conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { computeNegotiationStatus } from "../lib/negotiationStatus";

const SUMMARY_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

export function setDeadlineEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/negotiation/deadline`;
}

// Enhancement #6 -- a query-time-derived executive overview, never a
// stored/cached projection (see the session plan's own rejected-
// alternative #3: a materialized cache here was explicitly declined as
// premature optimization). Not a replacement for the full message/proposal
// history -- those stay available via their own list endpoints.
export async function getNegotiationSummary(poId: string, businessId: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");

  const [latestSubmittedProposal, secureLink, totalMessages, totalSubmittedProposals, latestAgreementSnapshot] = await Promise.all([
    prisma.po_negotiation_proposals.findFirst({
      where: { purchase_order_id: poId, submitted_at: { not: null } },
      orderBy: { submitted_at: "desc" },
    }),
    prisma.po_secure_links.findFirst({ where: { purchase_order_id: poId }, orderBy: { created_at: "desc" } }),
    prisma.po_negotiation_messages.count({ where: { purchase_order_id: poId } }),
    prisma.po_negotiation_proposals.count({ where: { purchase_order_id: poId, submitted_at: { not: null } } }),
    prisma.po_negotiation_agreement_snapshots.findFirst({ where: { purchase_order_id: poId }, orderBy: { negotiation_round: "desc" } }),
  ]);

  const status = computeNegotiationStatus(po, latestSubmittedProposal, secureLink, new Date());

  return {
    status,
    negotiationRound: po.negotiation_round,
    negotiationRespondBy: po.negotiation_respond_by,
    totalMessages,
    totalSubmittedProposals,
    latestProposal: latestSubmittedProposal,
    latestAgreementSnapshot,
  };
}

// Owner/manager only -- a plain metadata field on purchase_orders, version-
// guarded like every other PO mutation. respondBy: null clears the
// deadline (no expiry). Deadline comparison itself (in
// computeNegotiationStatus) is a plain Date comparison against "now" -- NOT
// getBusinessDay, since negotiation_respond_by is a real DateTime, not a
// calendar-only @db.Date column.
export async function setDeadline(poId: string, respondBy: Date | null, version: number, actor: { userId: string; businessId: string; userName: string; userRole: string }, idempotencyKey: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, setDeadlineEndpoint(poId));

    const guarded = await tx.purchase_orders.updateMany({
      where: { id: poId, business_id: actor.businessId, version },
      data: { negotiation_respond_by: respondBy, version: { increment: 1 } },
    });
    if (guarded.count === 0) throw conflict("Purchase order was modified concurrently, please retry with the latest version");

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.negotiation_deadline_set",
      entityType: "purchase_order",
      entityId: poId,
      reason: respondBy ? `Negotiation response deadline set to ${respondBy.toISOString()} on PO ${po.po_number}` : `Negotiation response deadline cleared on PO ${po.po_number}`,
    });

    const fresh = await tx.purchase_orders.findUniqueOrThrow({ where: { id: poId } });
    const responseBody = JSON.parse(JSON.stringify({ data: fresh })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, setDeadlineEndpoint(poId), 200, responseBody);
    return fresh;
  }, SUMMARY_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderNegotiationDeadlineSet", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    respondBy: respondBy ? respondBy.toISOString() : null,
  });

  return result;
}
