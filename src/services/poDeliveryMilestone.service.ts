import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { resolveAuditActor, type NegotiationActor } from "../lib/negotiationActor";
import type { CreateMilestoneInput, ListMilestonesQuery } from "../validation/poDeliveryMilestone.schema";
import type { DeliveryMilestoneType } from "@prisma/client";

const MILESTONE_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

export function createMilestoneEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/delivery-milestones`;
}

// The typical forward order -- used ONLY to compute an informational
// warning, never to block. "PoDeliveryMilestone rows are not strictly
// ordered/enforced sequentially this session... record what's reported,
// flag out-of-order data as a warning in the response if you want, but
// don't reject it; real-world logistics reporting isn't always clean."
const MILESTONE_ORDER: DeliveryMilestoneType[] = [
  "production_started",
  "production_finished",
  "packing",
  "ready_to_ship",
  "shipped",
  "customs_clearance",
  "arrived",
  "warehouse_received",
  "completed",
];

export async function createMilestone(poId: string, input: CreateMilestoneInput, actor: NegotiationActor, idempotencyKey: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");

  if (input.shipmentId) {
    const shipment = await getOwned(prisma.po_shipments.findUnique({ where: { id: input.shipmentId } }), actor.businessId, "Shipment");
    if (shipment.purchase_order_id !== poId) throw notFound("Shipment not found");
  }

  // Informational only -- never blocks. Warns when this milestone jumps
  // more than one step ahead of the highest-ranked milestone already
  // recorded for this PO (a real gap, e.g. "arrived" recorded with no
  // "shipped" ever logged), or when it re-records a stage already passed.
  const existing = await prisma.po_delivery_milestones.findMany({ where: { purchase_order_id: poId }, select: { milestone: true } });
  const existingRanks = existing.map((m) => MILESTONE_ORDER.indexOf(m.milestone));
  const highestRank = existingRanks.length > 0 ? Math.max(...existingRanks) : -1;
  const thisRank = MILESTONE_ORDER.indexOf(input.milestone);
  let warning: string | undefined;
  if (thisRank > highestRank + 1) {
    warning = `This milestone ("${input.milestone}") was recorded before one or more earlier stages (e.g. "${MILESTONE_ORDER[highestRank + 1]}") were ever logged for this PO.`;
  } else if (thisRank <= highestRank && thisRank !== -1 && !existing.some((m) => m.milestone === input.milestone)) {
    warning = `This milestone ("${input.milestone}") is earlier in the typical sequence than a stage already recorded for this PO.`;
  }

  const recordedByName = actor.party === "owner" ? actor.userName : actor.name;

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, createMilestoneEndpoint(poId));

    const created = await tx.po_delivery_milestones.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        shipment_id: input.shipmentId ?? null,
        milestone: input.milestone,
        planned_date: input.plannedDate,
        actual_date: input.actualDate,
        // recordedFrom is server-derived from the calling actor, never
        // trusted from client input -- see poShipment.schema.ts's own
        // comment for the reasoning.
        recorded_from: actor.party,
        recorded_by_name: recordedByName,
      },
    });

    const auditActor = resolveAuditActor(actor, po);
    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: auditActor.userId,
      userName: auditActor.userName,
      userRole: auditActor.userRole,
      action: "purchase_order.delivery_milestone_recorded",
      entityType: "po_delivery_milestone",
      entityId: created.id,
      reason: `Milestone "${input.milestone}" recorded for PO ${po.po_number}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: { ...created, warning } })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, createMilestoneEndpoint(poId), 201, responseBody);
    return created;
  }, MILESTONE_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderDeliveryMilestoneRecorded", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    milestoneId: result.id,
    milestone: result.milestone,
  });

  return { ...result, warning };
}

export async function listMilestones(poId: string, query: ListMilestonesQuery, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");

  const resolved = resolveListQuery(query, { sortableFields: ["created_at"] as const, defaultSort: "created_at" as const });
  const where = { business_id: businessId, purchase_order_id: poId };
  const [rows, total] = await Promise.all([
    prisma.po_delivery_milestones.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.po_delivery_milestones.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}
