import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import type { CreateInternalNoteInput, ListInternalNotesQuery } from "../validation/poNegotiationInternalNote.schema";

const NOTE_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export function createInternalNoteEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/negotiation/internal-notes`;
}

// Enhancement #8 -- Owner/Manager visibility only. Its own table,
// structurally unreachable from any supplier-portal code path (no query in
// that tree references po_negotiation_internal_notes at all) -- deliberately
// not merged into po_negotiation_messages, see the rejected-alternatives
// note in the session plan. Append-only: create + list, no edit/delete,
// matching this repo's "don't build a mutation path unless asked" restraint.
export async function createInternalNote(poId: string, input: CreateInternalNoteInput, actor: Actor, idempotencyKey: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, createInternalNoteEndpoint(poId));

    const created = await tx.po_negotiation_internal_notes.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        note_text: input.noteText,
        created_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.negotiation_internal_note_created",
      entityType: "po_negotiation_internal_note",
      entityId: created.id,
      reason: `Internal note added on PO ${po.po_number}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, createInternalNoteEndpoint(poId), 201, responseBody);
    return created;
  }, NOTE_TRANSACTION_OPTIONS);

  return result;
}

export async function listInternalNotes(poId: string, query: ListInternalNotesQuery, businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");

  const resolved = resolveListQuery(query, { sortableFields: ["created_at"] as const, defaultSort: "created_at" as const });

  const where = { business_id: businessId, purchase_order_id: poId };
  const [rows, total] = await Promise.all([
    prisma.po_negotiation_internal_notes.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.po_negotiation_internal_notes.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}
