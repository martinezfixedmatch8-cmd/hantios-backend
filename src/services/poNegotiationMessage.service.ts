import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { assertNegotiationOpen } from "../lib/poNegotiationGuards";
import { resolveAuditActor, type NegotiationActor } from "../lib/negotiationActor";
import type { ListMessagesQuery } from "../validation/poNegotiationMessage.schema";

// Same Neon-latency reasoning as every other transactional service in this
// repo.
const MESSAGE_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

export function createMessageEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/negotiation/messages`;
}
export function markMessageReadEndpoint(poId: string, messageId: string): string {
  return `POST /purchase-orders/${poId}/negotiation/messages/${messageId}/read`;
}

export interface CreateMessageServiceInput {
  messageText: string;
  replyToMessageId?: string;
}

export async function createMessage(
  poId: string,
  input: CreateMessageServiceInput,
  actor: NegotiationActor,
  idempotencyKey: string
) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  await assertNegotiationOpen(po);

  if (input.replyToMessageId) {
    const replyTarget = await getOwned(
      prisma.po_negotiation_messages.findUnique({ where: { id: input.replyToMessageId } }),
      actor.businessId,
      "Message"
    );
    if (replyTarget.purchase_order_id !== poId) throw notFound("Message not found");
  }

  const message = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, createMessageEndpoint(poId));

    const created = await tx.po_negotiation_messages.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        sender_type: actor.party,
        sender_name: actor.party === "owner" ? actor.userName : actor.name,
        sender_department: actor.party === "supplier" ? (actor.department ?? null) : null,
        sender_role: actor.party === "supplier" ? (actor.role ?? null) : null,
        message_text: input.messageText,
        reply_to_message_id: input.replyToMessageId ?? null,
        ip_address: actor.party === "supplier" ? actor.ipAddress : null,
      },
    });

    const auditActor = resolveAuditActor(actor, po);
    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: auditActor.userId,
      userName: auditActor.userName,
      userRole: auditActor.userRole,
      action: "purchase_order.negotiation_message_sent",
      entityType: "po_negotiation_message",
      entityId: created.id,
      reason: `Message sent on PO ${po.po_number}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, createMessageEndpoint(poId), 201, responseBody);
    return created;
  }, MESSAGE_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderNegotiationMessageSent", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    messageId: message.id,
    senderType: actor.party,
  });

  return message;
}

export async function listMessages(poId: string, query: ListMessagesQuery, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");

  const resolved = resolveListQuery(query, {
    sortableFields: ["created_at"] as const,
    defaultSort: "created_at" as const,
  });

  const where = { business_id: businessId, purchase_order_id: poId };
  const [rows, total] = await Promise.all([
    prisma.po_negotiation_messages.findMany({ where, include: { attachments: true }, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.po_negotiation_messages.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

// Sets read_at/read_by exactly once -- first read by the OTHER party only.
// The sender reading their own message is a no-op (not an error): returns
// the message unchanged. Already-read messages are also returned unchanged
// -- never overwritten on subsequent reads by construction (the guarded
// updateMany's own WHERE includes read_at: null).
export async function markMessageRead(poId: string, messageId: string, actor: NegotiationActor, idempotencyKey: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  const message = await getOwned(prisma.po_negotiation_messages.findUnique({ where: { id: messageId } }), actor.businessId, "Message");
  if (message.purchase_order_id !== poId) throw notFound("Message not found");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, markMessageReadEndpoint(poId, messageId));

    let didMarkRead = false;
    if (message.sender_type !== actor.party && !message.read_at) {
      const guarded = await tx.po_negotiation_messages.updateMany({
        where: { id: messageId, business_id: actor.businessId, read_at: null },
        data: { read_at: new Date(), read_by: actor.party },
      });
      didMarkRead = guarded.count > 0;
    }

    const fresh = await tx.po_negotiation_messages.findUniqueOrThrow({ where: { id: messageId } });
    const responseBody = JSON.parse(JSON.stringify({ data: fresh })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, markMessageReadEndpoint(poId, messageId), 200, responseBody);
    return { fresh, didMarkRead };
  }, MESSAGE_TRANSACTION_OPTIONS);

  if (result.didMarkRead) {
    domainEvents.publish("PurchaseOrderNegotiationMessageRead", {
      businessId: actor.businessId,
      purchaseOrderId: poId,
      messageId,
      readBy: actor.party,
    });
  }

  return result.fresh;
}
