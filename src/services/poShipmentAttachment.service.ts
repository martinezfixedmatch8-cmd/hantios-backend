import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { getStorageProvider } from "../storage/registry";
import { resolveAuditActor, type NegotiationActor } from "../lib/negotiationActor";
import type { PaginationQuery } from "../lib/pagination";
import type { ShipmentAttachmentType } from "@prisma/client";

interface UploadAttachmentServiceInput {
  type: ShipmentAttachmentType;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  storageKey: string;
}

const ATTACHMENT_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

export function uploadShipmentAttachmentEndpoint(poId: string, shipmentId: string): string {
  return `POST /purchase-orders/${poId}/shipments/${shipmentId}/attachments`;
}

// Addendum #23 -- immutable once cancelled (nothing more should happen on a
// cancelled shipment). Deliberately NOT blocked once delivered -- a real
// proof-of-delivery document (signed waybill, inspection certificate) can
// legitimately arrive slightly after the shipment is marked delivered.
export async function uploadShipmentAttachment(
  poId: string,
  shipmentId: string,
  input: UploadAttachmentServiceInput,
  actor: NegotiationActor,
  idempotencyKey: string
) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  const shipment = await getOwned(prisma.po_shipments.findUnique({ where: { id: shipmentId } }), actor.businessId, "Shipment");
  if (shipment.purchase_order_id !== poId) throw notFound("Shipment not found");
  if (shipment.status === "cancelled") {
    throw badRequest("Cannot add attachments to a cancelled shipment");
  }

  const uploaderName = actor.party === "owner" ? actor.userName : actor.name;

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, uploadShipmentAttachmentEndpoint(poId, shipmentId));

    const registered = await getStorageProvider().registerUpload({
      businessId: actor.businessId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.fileSizeBytes,
      clientStorageKey: input.storageKey,
    });

    const created = await tx.po_shipment_attachments.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        shipment_id: shipmentId,
        type: input.type,
        file_name: input.fileName,
        file_size_bytes: input.fileSizeBytes,
        storage_key: registered.storageKey,
        uploaded_by_party: actor.party,
        uploaded_by_name: uploaderName,
      },
    });

    const auditActor = resolveAuditActor(actor, po);
    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: auditActor.userId,
      userName: auditActor.userName,
      userRole: auditActor.userRole,
      action: "purchase_order.shipment_attachment_uploaded",
      entityType: "po_shipment_attachment",
      entityId: created.id,
      reason: `Attachment "${input.fileName}" (${input.type}) uploaded for shipment ${shipment.shipment_number}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, uploadShipmentAttachmentEndpoint(poId, shipmentId), 201, responseBody);
    return created;
  }, ATTACHMENT_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderShipmentAttachmentUploaded", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    shipmentId,
    attachmentId: result.id,
  });

  return result;
}

export async function listShipmentAttachments(poId: string, shipmentId: string, query: PaginationQuery, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");
  const shipment = await getOwned(prisma.po_shipments.findUnique({ where: { id: shipmentId } }), businessId, "Shipment");
  if (shipment.purchase_order_id !== poId) throw notFound("Shipment not found");

  const resolved = resolveListQuery(query, { sortableFields: ["uploaded_at"] as const, defaultSort: "uploaded_at" as const });
  const where = { business_id: businessId, shipment_id: shipmentId };
  const [rows, total] = await Promise.all([
    prisma.po_shipment_attachments.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.po_shipment_attachments.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}
