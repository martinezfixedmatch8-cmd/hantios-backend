import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { assertOwned, getOwned } from "../lib/ownership";
import { badRequest, conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { getNextGrnNumber } from "../lib/grnNumber";
import { getOrCreateWarehouse } from "../lib/warehouse";
import { recordWarehouseMovement } from "../lib/warehouseStock";
import type { CreateGoodsReceivedNoteInput } from "../validation/goodsReceivedNote.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Same Neon-latency reasoning as every other transactional service in this
// repo -- a GRN write does a counter allocation + header insert + N item
// inserts + N warehouse-stock movements + a PO status recompute + audit log
// + idempotency completion, several sequential round trips deep.
const GRN_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

const GRN_INCLUDE = { goods_received_items: true } as const;

// PO statuses a GRN may be received against -- not draft (never sent to the
// supplier yet), not cancelled. `received` is included: over-delivery/extra
// shipments against an already-fully-received PO are a real, if unusual,
// scenario the schema already accounts for via variance_quantity.
const RECEIVABLE_PO_STATUSES = ["sent", "confirmed", "partially_received", "received"] as const;
type ReceivablePoStatus = (typeof RECEIVABLE_PO_STATUSES)[number];

export function createGoodsReceivedNoteEndpoint(purchaseOrderId: string): string {
  return `POST /purchase-orders/${purchaseOrderId}/goods-received-notes`;
}

export async function createGoodsReceivedNote(
  purchaseOrderId: string,
  input: CreateGoodsReceivedNoteInput,
  actor: Actor,
  idempotencyKey: string
) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: purchaseOrderId } }), actor.businessId, "Purchase order");
  if (!RECEIVABLE_PO_STATUSES.includes(po.status as ReceivablePoStatus)) {
    throw badRequest(
      `Purchase order status "${po.status}" cannot receive goods (must be sent, confirmed, partially_received, or received)`
    );
  }

  // Scoped to THIS PO's own items -- a poItemId belonging to a different PO
  // (even within the same business) simply won't be in this map, so
  // assertOwned's 404 below covers both "doesn't exist" and "belongs to a
  // different PO/business" uniformly, without a second manual check.
  const poItems = await prisma.purchase_order_items.findMany({ where: { purchase_order_id: purchaseOrderId } });
  const poItemMap = new Map(poItems.map((i) => [i.id, i]));

  const resolvedLines = input.items.map((item) => {
    const poItem = assertOwned(poItemMap.get(item.poItemId), actor.businessId, "Purchase order item");
    const quantityReceived = new Prisma.Decimal(item.quantityReceived);
    const unitCostActual = new Prisma.Decimal(item.unitCostActual);
    // Signed, computed per-GRN against the line's FULL ordered quantity (not
    // a running remaining-balance) -- matches the schema's own documented
    // intent: "on THIS GRN specifically," a human-readable discrepancy
    // signal per shipment, not a cumulative fulfillment tracker (that's what
    // the PO status recomputation below is for).
    const varianceQuantity = quantityReceived.minus(poItem.quantity_ordered);
    return { poItem, quantityReceived, unitCostActual, varianceQuantity };
  });

  const warehouse = await getOrCreateWarehouse(prisma, actor.businessId);

  const grn = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, createGoodsReceivedNoteEndpoint(purchaseOrderId));

    const grnNumber = await getNextGrnNumber(tx, actor.businessId);

    const createdGrn = await tx.goods_received_notes.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: purchaseOrderId,
        grn_number: grnNumber,
        supplier_delivery_note: input.supplierDeliveryNote,
        variance_notes: input.varianceNotes,
        received_by: actor.userId,
      },
    });

    for (const line of resolvedLines) {
      await tx.goods_received_items.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          grn_id: createdGrn.id,
          po_item_id: line.poItem.id,
          product_id: line.poItem.product_id,
          quantity_received: line.quantityReceived,
          unit_cost_actual: line.unitCostActual,
          variance_quantity: line.varianceQuantity,
        },
      });

      await recordWarehouseMovement(tx, {
        businessId: actor.businessId,
        warehouseId: warehouse.id,
        productId: line.poItem.product_id,
        quantity: line.quantityReceived,
        movementType: "stock_in",
        grnId: createdGrn.id,
        unitCost: line.unitCostActual,
        createdBy: actor.userId,
      });
    }

    // GRN -> PO status derivation (locked decision): received iff cumulative
    // quantity_received (across every GRN, including this one) >=
    // quantity_ordered for EVERY line on the PO; partially_received
    // otherwise. A recomputation, not a fixed-source-status FSM transition
    // like send/confirm/cancel -- matches how Debt status is "purely
    // derived from the amounts."
    const receivedSums = await tx.goods_received_items.groupBy({
      by: ["po_item_id"],
      where: { po_item_id: { in: poItems.map((i) => i.id) } },
      _sum: { quantity_received: true },
    });
    const receivedMap = new Map(receivedSums.map((r) => [r.po_item_id, r._sum.quantity_received ?? new Prisma.Decimal(0)]));
    const fullyReceived = poItems.every((item) => {
      const received = receivedMap.get(item.id) ?? new Prisma.Decimal(0);
      return received.greaterThanOrEqualTo(item.quantity_ordered);
    });
    const newStatus = fullyReceived ? "received" : "partially_received";

    // Version-guarded, still carrying the receivable-status condition too
    // (defense-in-depth, same PATCH-vs-send/confirm/cancel shape Purchase
    // Orders' own PATCH already established) -- a concurrent cancel between
    // the initial check and now is caught here rather than silently
    // overwritten.
    const updateResult = await tx.purchase_orders.updateMany({
      where: { id: purchaseOrderId, business_id: actor.businessId, version: input.version, status: { in: [...RECEIVABLE_PO_STATUSES] } },
      data: { status: newStatus, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Purchase order was modified concurrently, or is no longer in a receivable state -- please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.goods_received",
      entityType: "goods_received_note",
      entityId: createdGrn.id,
      reason: `GRN ${grnNumber} received against PO ${po.po_number} (${resolvedLines.length} line item(s)), PO status now ${newStatus}`,
    });

    const withItems = await tx.goods_received_notes.findUniqueOrThrow({ where: { id: createdGrn.id }, include: GRN_INCLUDE });
    const responseBody = JSON.parse(JSON.stringify({ data: withItems })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, createGoodsReceivedNoteEndpoint(purchaseOrderId), 201, responseBody);

    return { grn: withItems, newStatus };
  }, GRN_TRANSACTION_OPTIONS);

  domainEvents.publish("GoodsReceivedNoteCreated", {
    businessId: actor.businessId,
    grnId: grn.grn.id,
    grnNumber: grn.grn.grn_number,
    purchaseOrderId,
    purchaseOrderStatus: grn.newStatus,
  });

  return grn.grn;
}
