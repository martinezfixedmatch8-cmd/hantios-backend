import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { assertNegotiationOpen } from "../lib/poNegotiationGuards";
import { resolveAuditActor, type NegotiationActor } from "../lib/negotiationActor";
import { getStorageProvider } from "../storage/registry";
import { mimeTypeToAttachmentType } from "../validation/poNegotiationAttachment.schema";

const ATTACHMENT_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

export function uploadAttachmentEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/negotiation/attachments`;
}

export interface UploadAttachmentServiceInput {
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  storageKey: string;
  messageId?: string;
  proposalId?: string;
}

// The standalone attachment endpoint -- XOR-validated at the Zod layer
// (exactly one of messageId/proposalId), used for attaching to a MESSAGE
// (always allowed, messages have no immutability-vs-mutability distinction
// to worry about) or adding one more file to an already-drafted PROPOSAL
// without resending the whole draft (only while status="draft" -- once
// submitted/resolved a proposal is immutable, same rule its own
// changes/comment are held to). Enhancement #2's "one submission" bundling
// for proposals is the separate inline-attachments path on
// saveDraft/draftProposalSchema; this endpoint is the base spec's own
// always-available attach-a-file mechanism, still needed for messages and
// for the "just one more file" case on an existing draft.
export async function uploadAttachment(poId: string, input: UploadAttachmentServiceInput, actor: NegotiationActor, idempotencyKey: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  await assertNegotiationOpen(po);

  if (input.messageId) {
    const message = await getOwned(prisma.po_negotiation_messages.findUnique({ where: { id: input.messageId } }), actor.businessId, "Message");
    if (message.purchase_order_id !== poId) throw notFound("Message not found");
  }
  if (input.proposalId) {
    const proposal = await getOwned(prisma.po_negotiation_proposals.findUnique({ where: { id: input.proposalId } }), actor.businessId, "Proposal");
    if (proposal.purchase_order_id !== poId) throw notFound("Proposal not found");
    if (proposal.status !== "draft") throw badRequest("Attachments can only be added to a proposal while it is still a draft");
  }

  const uploaderName = actor.party === "owner" ? actor.userName : actor.name;

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, uploadAttachmentEndpoint(poId));

    const registered = await getStorageProvider().registerUpload({
      businessId: actor.businessId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.fileSizeBytes,
      clientStorageKey: input.storageKey,
    });

    const created = await tx.po_negotiation_attachments.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        message_id: input.messageId ?? null,
        proposal_id: input.proposalId ?? null,
        type: mimeTypeToAttachmentType(input.mimeType),
        file_name: input.fileName,
        file_size_bytes: input.fileSizeBytes,
        storage_key: registered.storageKey,
        uploaded_by: actor.party,
        uploaded_by_name: uploaderName,
      },
    });

    const auditActor = resolveAuditActor(actor, po);
    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: auditActor.userId,
      userName: auditActor.userName,
      userRole: auditActor.userRole,
      action: "purchase_order.negotiation_attachment_uploaded",
      entityType: "po_negotiation_attachment",
      entityId: created.id,
      reason: `Attachment "${input.fileName}" uploaded on PO ${po.po_number}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, uploadAttachmentEndpoint(poId), 201, responseBody);
    return created;
  }, ATTACHMENT_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderNegotiationAttachmentUploaded", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    attachmentId: result.id,
  });

  return result;
}
