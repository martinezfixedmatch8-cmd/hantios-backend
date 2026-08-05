import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { assertOwned, getOwned } from "../lib/ownership";
import { badRequest, conflict, notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { getOrCreateWarehouse } from "../lib/warehouse";
import { getNextShipmentNumber } from "../lib/shipmentNumber";
import {
  computeShippingStatus,
  suggestCostResponsibility,
  isValidShipmentTransition,
  TERMINAL_SHIPMENT_STATUSES,
} from "../lib/shipmentStatus";
import { resolveAuditActor, type NegotiationActor } from "../lib/negotiationActor";
import type {
  CreateShipmentInput,
  UpdateShipmentStatusInput,
  UpdateShipmentEtaInput,
  UpdateShipmentInput,
  ListShipmentsQuery,
} from "../validation/poShipment.schema";

// Same Neon-latency reasoning as every other transactional service in this
// repo -- shipment creation in particular does a counter allocation +
// header insert + N item inserts + a status-history insert + audit log +
// idempotency completion, several sequential round trips deep.
const SHIPMENT_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

const SHIPMENT_INCLUDE = { items: true, attachments: true, eta_updates: true, status_history: true } as const;

// A PO must actually be sent (or further along) before it can receive a
// shipment -- mirrors GRN's own RECEIVABLE_PO_STATUSES bar exactly (a DRAFT
// PO's terms aren't final, a CANCELLED one has nothing to ship).
const SHIPPABLE_PO_STATUSES = ["sent", "confirmed", "partially_received", "received"] as const;
type ShippablePoStatus = (typeof SHIPPABLE_PO_STATUSES)[number];

export function createShipmentEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/shipments`;
}
export function updateShipmentStatusEndpoint(poId: string, shipmentId: string): string {
  return `PATCH /purchase-orders/${poId}/shipments/${shipmentId}/status`;
}
export function updateShipmentEndpoint(poId: string, shipmentId: string): string {
  return `PATCH /purchase-orders/${poId}/shipments/${shipmentId}`;
}
export function updateShipmentEtaEndpoint(poId: string, shipmentId: string): string {
  return `POST /purchase-orders/${poId}/shipments/${shipmentId}/eta`;
}

function actorName(actor: NegotiationActor): string | undefined {
  return actor.party === "owner" ? actor.userName : actor.name;
}

// Addendum #15 -- snapshotted once at shipment creation from whichever of
// branches.location/warehouses.location the PO actually resolves to; this
// schema has no dedicated structured address entity anywhere. A later edit
// to the live branch/warehouse record must never retroactively change a
// historical shipment's own agreed destination.
async function buildDeliveryAddressSnapshot(businessId: string, branchId: string | null): Promise<Prisma.InputJsonValue> {
  if (branchId) {
    const branch = await prisma.branches.findUnique({ where: { id: branchId } });
    if (branch) {
      return { source: "branch", branchId: branch.id, branchName: branch.name, location: branch.location };
    }
  }
  const warehouse = await getOrCreateWarehouse(prisma, businessId);
  return { source: "warehouse", warehouseId: warehouse.id, warehouseName: warehouse.name, location: warehouse.location };
}

// Cumulative quantity_shipped per po_item_id, EXCLUDING cancelled shipments
// -- a cancelled shipment never actually happened, so its item quantities
// must not count against "remaining to ship." Mirrors goods_received_items'
// own groupBy-then-compare pattern exactly (confirmed in Phase 0).
async function getShippedSumsByPoItem(poId: string, poItemIds: string[]): Promise<Map<string, Prisma.Decimal>> {
  const activeShipments = await prisma.po_shipments.findMany({
    where: { purchase_order_id: poId, status: { not: "cancelled" } },
    select: { id: true },
  });
  const activeShipmentIds = activeShipments.map((s) => s.id);
  if (activeShipmentIds.length === 0) return new Map();

  const sums = await prisma.po_shipment_items.groupBy({
    by: ["po_item_id"],
    where: { po_item_id: { in: poItemIds }, shipment_id: { in: activeShipmentIds } },
    _sum: { quantity_shipped: true },
  });
  return new Map(sums.map((s) => [s.po_item_id, s._sum.quantity_shipped ?? new Prisma.Decimal(0)]));
}

export async function createShipment(poId: string, input: CreateShipmentInput, actor: NegotiationActor, idempotencyKey: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  if (!SHIPPABLE_PO_STATUSES.includes(po.status as ShippablePoStatus)) {
    throw badRequest(`Purchase order status "${po.status}" cannot receive a shipment (must be sent, confirmed, partially_received, or received)`);
  }

  const poItems = await prisma.purchase_order_items.findMany({ where: { purchase_order_id: poId } });
  const poItemMap = new Map(poItems.map((i) => [i.id, i]));
  const shippedSoFarMap = await getShippedSumsByPoItem(poId, poItems.map((i) => i.id));

  const resolvedLines = input.items.map((item) => {
    const poItem = assertOwned(poItemMap.get(item.poItemId), actor.businessId, "Purchase order item");
    const quantityShipped = new Prisma.Decimal(item.quantityShipped);
    const shippedSoFar = shippedSoFarMap.get(poItem.id) ?? new Prisma.Decimal(0);
    const newTotal = shippedSoFar.plus(quantityShipped);
    // Addendum #22 -- hard block, a deliberate divergence from GRN's own
    // allow-and-flag over-delivery precedent: a shipment quantity is a
    // self-reported commitment BEFORE physical receipt, not physical
    // reality after the fact, so rejecting an impossible over-commitment
    // is a data-integrity check, not a rejection of reality.
    if (newTotal.greaterThan(poItem.quantity_ordered)) {
      throw badRequest(
        `Shipping ${quantityShipped.toString()} of "${poItem.product_name_snapshot}" would bring cumulative shipped quantity to ${newTotal.toString()}, exceeding the ordered quantity of ${poItem.quantity_ordered.toString()}`
      );
    }
    return { poItem, quantityShipped };
  });

  const deliveryAddressSnapshot = await buildDeliveryAddressSnapshot(actor.businessId, po.branch_id);
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });

  // Explicit override wins; otherwise server-suggests from incoterms, never
  // silently re-derived once set (see suggestCostResponsibility's own
  // comment for the simplification this heuristic makes).
  const costResponsibility = input.costResponsibility ?? suggestCostResponsibility(input.incoterms ?? null) ?? null;
  const insuranceResponsibility = input.insuranceResponsibility ?? suggestCostResponsibility(input.incoterms ?? null) ?? null;
  const createdByName = actorName(actor);

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, createShipmentEndpoint(poId));

    const shipmentNumber = await getNextShipmentNumber(tx, actor.businessId, business.timezone);

    const created = await tx.po_shipments.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        shipment_number: shipmentNumber,
        method: input.method,
        carrier: input.carrier,
        tracking_reference: input.trackingReference,
        tracking_type: input.trackingType,
        container_no: input.containerNo,
        vessel_or_flight: input.vesselOrFlight,
        port_of_departure: input.portOfDeparture,
        port_of_arrival: input.portOfArrival,
        expected_arrival_from: input.expectedArrivalFrom,
        expected_arrival_to: input.expectedArrivalTo,
        incoterms: input.incoterms,
        cost_responsibility: costResponsibility,
        shipping_cost: input.shippingCost,
        insurance: input.insurance,
        insurance_responsibility: insuranceResponsibility,
        customs_cost: input.customsCost,
        customs_notes: input.customsNotes,
        priority: input.priority,
        delivery_address_snapshot: deliveryAddressSnapshot,
        supplier_reference: input.supplierReference,
        carrier_reference: input.carrierReference,
        customs_reference: input.customsReference,
        created_by_party: actor.party,
        created_by_name: createdByName,
      },
    });

    for (const line of resolvedLines) {
      await tx.po_shipment_items.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          shipment_id: created.id,
          po_item_id: line.poItem.id,
          quantity_shipped: line.quantityShipped,
        },
      });
    }

    await tx.po_shipment_status_history.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        shipment_id: created.id,
        from_status: null,
        to_status: "pending",
        changed_by_party: actor.party,
        changed_by_name: createdByName,
      },
    });

    const auditActor = resolveAuditActor(actor, po);
    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: auditActor.userId,
      userName: auditActor.userName,
      userRole: auditActor.userRole,
      action: "purchase_order.shipment_created",
      entityType: "po_shipment",
      entityId: created.id,
      reason: `Shipment ${shipmentNumber} created for PO ${po.po_number}`,
    });

    const fresh = await tx.po_shipments.findUniqueOrThrow({ where: { id: created.id }, include: SHIPMENT_INCLUDE });
    const responseBody = JSON.parse(JSON.stringify({ data: fresh })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, createShipmentEndpoint(poId), 201, responseBody);
    return fresh;
  }, SHIPMENT_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderShipmentCreated", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    shipmentId: result.id,
    shipmentNumber: result.shipment_number,
  });

  return result;
}

export async function listShipments(poId: string, query: ListShipmentsQuery, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");

  const resolved = resolveListQuery(query, { sortableFields: ["created_at"] as const, defaultSort: "created_at" as const });
  const where = { business_id: businessId, purchase_order_id: poId };
  const [rows, total] = await Promise.all([
    prisma.po_shipments.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.po_shipments.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

export async function getShipment(poId: string, shipmentId: string, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");
  const shipment = await getOwned(
    prisma.po_shipments.findUnique({ where: { id: shipmentId }, include: SHIPMENT_INCLUDE }),
    businessId,
    "Shipment"
  );
  if (shipment.purchase_order_id !== poId) throw notFound("Shipment not found");
  return shipment;
}

export async function updateShipmentStatus(
  poId: string,
  shipmentId: string,
  input: UpdateShipmentStatusInput,
  actor: NegotiationActor,
  idempotencyKey: string
) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  const shipment = await getOwned(prisma.po_shipments.findUnique({ where: { id: shipmentId } }), actor.businessId, "Shipment");
  if (shipment.purchase_order_id !== poId) throw notFound("Shipment not found");

  if (!isValidShipmentTransition(shipment.status, input.status)) {
    throw badRequest(`Cannot transition shipment from "${shipment.status}" to "${input.status}"`);
  }

  const changedByName = actorName(actor);

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, updateShipmentStatusEndpoint(poId, shipmentId));

    const data: Prisma.po_shipmentsUpdateManyMutationInput = { status: input.status, version: { increment: 1 } };
    if (input.status === "cancelled") {
      data.cancel_reason = input.cancelReason;
      data.cancel_reason_notes = input.cancelReasonNotes ?? null;
    }
    if (input.status === "arrived") {
      data.actual_arrival = input.actualArrival ?? new Date();
    }
    if (input.status === "delivered") {
      data.actual_arrival = shipment.actual_arrival ?? input.actualArrival ?? new Date();
      data.received_by = input.receivedBy ?? null;
      data.received_at = input.receivedAt ?? new Date();
      data.receiver_notes = input.receiverNotes ?? null;
    }

    // Addendum #23's version lock in practice: the WHERE clause's own
    // status: shipment.status condition means a shipment that reached
    // delivered/cancelled concurrently (or any status other than the one
    // this request read) is rejected atomically here too, not just by the
    // pre-check above.
    const guarded = await tx.po_shipments.updateMany({
      where: { id: shipmentId, business_id: actor.businessId, version: input.version, status: shipment.status },
      data,
    });
    if (guarded.count === 0) {
      throw conflict("Shipment was modified concurrently, please retry with the latest version");
    }

    await tx.po_shipment_status_history.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        shipment_id: shipmentId,
        from_status: shipment.status,
        to_status: input.status,
        changed_by_party: actor.party,
        changed_by_name: changedByName,
        note: input.note,
      },
    });

    const auditActor = resolveAuditActor(actor, po);
    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: auditActor.userId,
      userName: auditActor.userName,
      userRole: auditActor.userRole,
      action: "purchase_order.shipment_status_changed",
      entityType: "po_shipment",
      entityId: shipmentId,
      reason: input.note ?? `Shipment ${shipment.shipment_number} status changed from ${shipment.status} to ${input.status}`,
    });

    const fresh = await tx.po_shipments.findUniqueOrThrow({ where: { id: shipmentId }, include: SHIPMENT_INCLUDE });
    const responseBody = JSON.parse(JSON.stringify({ data: fresh })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, updateShipmentStatusEndpoint(poId, shipmentId), 200, responseBody);
    return fresh;
  }, SHIPMENT_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderShipmentStatusChanged", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    shipmentId,
    fromStatus: shipment.status,
    toStatus: input.status,
  });

  return result;
}

// PATCH /purchase-orders/:id/shipments/:shipmentId -- added on second
// review. LOCKED, explicit editable-field allowlist enforced at the Zod
// layer (uploadShipmentSchema's own `.strict()`): only logistics-execution
// details that legitimately arrive/change after creation (carrier,
// tracking, costs, priority). Nothing that defines the shipment's core
// identity or contractual terms is reachable through this endpoint at all.
// version + status are checked in ONE atomic guarded updateMany -- a stale
// version and an already-delivered/cancelled shipment both produce the
// same 409, exactly as every other version-locked mutation in this repo
// does (count===0 covers both uniformly, no separate pre-check needed or
// wanted here).
export async function updateShipment(
  poId: string,
  shipmentId: string,
  input: UpdateShipmentInput,
  actor: NegotiationActor,
  idempotencyKey: string
) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  const shipment = await getOwned(prisma.po_shipments.findUnique({ where: { id: shipmentId } }), actor.businessId, "Shipment");
  if (shipment.purchase_order_id !== poId) throw notFound("Shipment not found");

  const data: Prisma.po_shipmentsUpdateManyMutationInput = { version: { increment: 1 } };
  const beforeState: Record<string, unknown> = {};
  const afterState: Record<string, unknown> = {};

  if (input.carrier !== undefined) {
    beforeState.carrier = shipment.carrier;
    afterState.carrier = input.carrier;
    data.carrier = input.carrier;
  }
  if (input.trackingReference !== undefined) {
    beforeState.trackingReference = shipment.tracking_reference;
    afterState.trackingReference = input.trackingReference;
    data.tracking_reference = input.trackingReference;
  }
  if (input.trackingType !== undefined) {
    beforeState.trackingType = shipment.tracking_type;
    afterState.trackingType = input.trackingType;
    data.tracking_type = input.trackingType;
  }
  if (input.shippingCost !== undefined) {
    beforeState.shippingCost = shipment.shipping_cost.toString();
    afterState.shippingCost = input.shippingCost;
    data.shipping_cost = new Prisma.Decimal(input.shippingCost);
  }
  if (input.insurance !== undefined) {
    beforeState.insurance = shipment.insurance.toString();
    afterState.insurance = input.insurance;
    data.insurance = new Prisma.Decimal(input.insurance);
  }
  if (input.customsCost !== undefined) {
    beforeState.customsCost = shipment.customs_cost.toString();
    afterState.customsCost = input.customsCost;
    data.customs_cost = new Prisma.Decimal(input.customsCost);
  }
  if (input.priority !== undefined) {
    beforeState.priority = shipment.priority;
    afterState.priority = input.priority;
    data.priority = input.priority;
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, updateShipmentEndpoint(poId, shipmentId));

    const guarded = await tx.po_shipments.updateMany({
      where: { id: shipmentId, business_id: actor.businessId, version: input.version, status: { notIn: TERMINAL_SHIPMENT_STATUSES } },
      data,
    });
    if (guarded.count === 0) {
      throw conflict(
        "Shipment was modified concurrently, or has already reached a terminal status (delivered/cancelled) -- please retry with the latest version"
      );
    }

    const auditActor = resolveAuditActor(actor, po);
    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: auditActor.userId,
      userName: auditActor.userName,
      userRole: auditActor.userRole,
      action: "purchase_order.shipment_updated",
      entityType: "po_shipment",
      entityId: shipmentId,
      beforeState,
      afterState,
      reason: input.reason,
    });

    const fresh = await tx.po_shipments.findUniqueOrThrow({ where: { id: shipmentId }, include: SHIPMENT_INCLUDE });
    const responseBody = JSON.parse(JSON.stringify({ data: fresh })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, updateShipmentEndpoint(poId, shipmentId), 200, responseBody);
    return fresh;
  }, SHIPMENT_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderShipmentUpdated", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    shipmentId,
    changedFields: Object.keys(afterState),
  });

  return result;
}

export async function updateShipmentEta(
  poId: string,
  shipmentId: string,
  input: UpdateShipmentEtaInput,
  actor: NegotiationActor,
  idempotencyKey: string
) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  const shipment = await getOwned(prisma.po_shipments.findUnique({ where: { id: shipmentId } }), actor.businessId, "Shipment");
  if (shipment.purchase_order_id !== poId) throw notFound("Shipment not found");
  if (TERMINAL_SHIPMENT_STATUSES.includes(shipment.status)) {
    throw badRequest(`Cannot update the arrival window for a shipment that is already ${shipment.status}`);
  }

  const updatedByName = actorName(actor);
  const newFrom = input.newExpectedArrivalFrom ?? shipment.expected_arrival_from;
  const newTo = input.newExpectedArrivalTo ?? shipment.expected_arrival_to;

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, updateShipmentEtaEndpoint(poId, shipmentId));

    const guarded = await tx.po_shipments.updateMany({
      where: { id: shipmentId, business_id: actor.businessId, status: { notIn: TERMINAL_SHIPMENT_STATUSES } },
      data: { expected_arrival_from: newFrom, expected_arrival_to: newTo },
    });
    if (guarded.count === 0) {
      throw conflict("Shipment reached a terminal status concurrently -- its arrival window can no longer be updated");
    }

    await tx.po_eta_updates.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        shipment_id: shipmentId,
        old_expected_arrival_from: shipment.expected_arrival_from,
        old_expected_arrival_to: shipment.expected_arrival_to,
        new_expected_arrival_from: newFrom,
        new_expected_arrival_to: newTo,
        reason_category: input.reasonCategory,
        reason: input.reason,
        updated_by_party: actor.party,
        updated_by_name: updatedByName,
      },
    });

    const auditActor = resolveAuditActor(actor, po);
    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: auditActor.userId,
      userName: auditActor.userName,
      userRole: auditActor.userRole,
      action: "purchase_order.shipment_eta_changed",
      entityType: "po_shipment",
      entityId: shipmentId,
      reason: `${input.reasonCategory}: ${input.reason}`,
    });

    const fresh = await tx.po_shipments.findUniqueOrThrow({ where: { id: shipmentId } });
    const responseBody = JSON.parse(JSON.stringify({ data: fresh })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, updateShipmentEtaEndpoint(poId, shipmentId), 200, responseBody);
    return fresh;
  }, SHIPMENT_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderShipmentEtaChanged", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    shipmentId,
    newExpectedArrivalFrom: result.expected_arrival_from ? result.expected_arrival_from.toISOString() : null,
    newExpectedArrivalTo: result.expected_arrival_to ? result.expected_arrival_to.toISOString() : null,
  });

  return result;
}

// Bundles addendum #13's PO-level derived shipping status alongside the
// per-item shipped-vs-ordered breakdown -- computed fresh on every call,
// never stored. :id in the URL identifies the shipment used to resolve
// ownership, but the breakdown itself is inherently PO-wide (cumulative
// across every non-cancelled shipment), matching what "remaining to ship"
// actually means.
export async function getRemainingQuantities(poId: string, shipmentId: string, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");
  const shipment = await getOwned(prisma.po_shipments.findUnique({ where: { id: shipmentId } }), businessId, "Shipment");
  if (shipment.purchase_order_id !== poId) throw notFound("Shipment not found");

  const poItems = await prisma.purchase_order_items.findMany({ where: { purchase_order_id: poId } });
  const shippedMap = await getShippedSumsByPoItem(poId, poItems.map((i) => i.id));

  const items = poItems.map((item) => {
    const shipped = shippedMap.get(item.id) ?? new Prisma.Decimal(0);
    return {
      poItemId: item.id,
      productNameSnapshot: item.product_name_snapshot,
      quantityOrdered: item.quantity_ordered,
      quantityShipped: shipped,
      quantityRemaining: item.quantity_ordered.minus(shipped),
    };
  });

  const shippingStatus = computeShippingStatus(items.map((i) => ({ poItemId: i.poItemId, quantityOrdered: i.quantityOrdered, quantityShipped: i.quantityShipped })));

  return { shippingStatus, items };
}
