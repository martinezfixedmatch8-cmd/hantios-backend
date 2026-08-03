import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { recordSupplierView } from "../services/poSecureLink.service";
import { domainEvents } from "../lib/events";
import { buildSupplierActor } from "../lib/negotiationActor";
import { createSupplierMessageSchema, listMessagesQuerySchema } from "../validation/poNegotiationMessage.schema";
import * as messageService from "../services/poNegotiationMessage.service";
import {
  draftSupplierProposalSchema,
  submitSupplierProposalSchema,
  rejectSupplierProposalSchema,
  listProposalsQuerySchema,
} from "../validation/poNegotiationProposal.schema";
import * as proposalService from "../services/poNegotiationProposal.service";
import { uploadSupplierAttachmentSchema } from "../validation/poNegotiationAttachment.schema";
import * as attachmentService from "../services/poNegotiationAttachment.service";
import * as summaryService from "../services/poNegotiationSummary.service";
import { getReplayedResponse } from "../lib/idempotency";

function getSecureLink(req: Request) {
  // secureLinkAuth guarantees this is set on every route in this router --
  // not re-checked here, mirroring how authenticate/req.auth is trusted
  // once past requireRole on the owner side.
  return req.secureLink!;
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

const messageIdParamSchema = z.object({ messageId: z.string().uuid() });
const proposalIdParamSchema = z.object({ proposalId: z.string().uuid() });

// GET /portal/po/:token -- full read-only PO view. Every view updates
// last_viewed_at/view_count (no per-view limit while the link is active,
// beyond the shared supplierPortalLimiter); only the FIRST view publishes
// PurchaseOrderViewedBySupplier (debounced, mirrors StockLow's own shape).
// Bundles the Stage 5 negotiation summary (status/round/deadline) directly
// onto this response -- the supplier's one-stop read, matching the base
// spec's own "bundle related records on the parent's read endpoint"
// precedent already used by GRN/PO-Payments on the owner side.
export async function viewPurchaseOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { link, purchaseOrder } = getSecureLink(req);

    const { isFirstView } = await recordSupplierView(link.id);
    if (isFirstView) {
      domainEvents.publish("PurchaseOrderViewedBySupplier", {
        businessId: purchaseOrder.business_id,
        purchaseOrderId: purchaseOrder.id,
        occurredAt: new Date().toISOString(),
      });
    }

    const withItems = await prisma.purchase_orders.findUniqueOrThrow({
      where: { id: purchaseOrder.id },
      include: { purchase_order_items: true },
    });
    const negotiation = await summaryService.getNegotiationSummary(purchaseOrder.id, purchaseOrder.business_id);

    res.status(200).json({ data: { ...withItems, negotiation } });
  } catch (err) {
    next(err);
  }
}

export async function getNegotiationSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const summary = await summaryService.getNegotiationSummary(purchaseOrder.id, purchaseOrder.business_id);
    res.status(200).json({ data: summary });
  } catch (err) {
    next(err);
  }
}

export async function createMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(purchaseOrder.business_id, idempotencyKey, messageService.createMessageEndpoint(purchaseOrder.id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createSupplierMessageSchema.parse(req.body);
    const actor = await buildSupplierActor(req, { senderName: input.senderName, senderPhone: input.senderPhone });
    const message = await messageService.createMessage(purchaseOrder.id, input, actor, idempotencyKey);
    res.status(201).json({ data: message });
  } catch (err) {
    next(err);
  }
}

export async function listMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const query = listMessagesQuerySchema.parse(req.query);
    const result = await messageService.listMessages(purchaseOrder.id, query, purchaseOrder.business_id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function markMessageRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const { messageId } = messageIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(
      purchaseOrder.business_id,
      idempotencyKey,
      messageService.markMessageReadEndpoint(purchaseOrder.id, messageId)
    );
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    // A supplier marking a message read doesn't need name/phone (per the
    // spec: only state-changing actions like Accept/Reject/Submit/Approve
    // require identity confirmation -- marking a message read is not one of
    // those). A minimal, unidentified supplier actor is sufficient here
    // since read_by only ever stores the PARTY ("owner"/"supplier"), never
    // a name.
    const actor = { party: "supplier" as const, businessId: purchaseOrder.business_id, name: "", phone: "", ipAddress: req.ip ?? null };
    const message = await messageService.markMessageRead(purchaseOrder.id, messageId, actor, idempotencyKey);
    res.status(200).json({ data: message });
  } catch (err) {
    next(err);
  }
}

export async function saveDraftProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(purchaseOrder.business_id, idempotencyKey, proposalService.draftProposalEndpoint(purchaseOrder.id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = draftSupplierProposalSchema.parse(req.body);
    const actor = await buildSupplierActor(req, { senderName: input.senderName, senderPhone: input.senderPhone });
    const proposal = await proposalService.saveDraft(purchaseOrder.id, input, actor, idempotencyKey);
    res.status(200).json({ data: proposal });
  } catch (err) {
    next(err);
  }
}

export async function submitProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const { proposalId } = proposalIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(
      purchaseOrder.business_id,
      idempotencyKey,
      proposalService.submitProposalEndpoint(purchaseOrder.id, proposalId)
    );
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = submitSupplierProposalSchema.parse(req.body);
    const actor = await buildSupplierActor(req, { senderName: input.senderName, senderPhone: input.senderPhone });
    const proposal = await proposalService.submitProposal(purchaseOrder.id, proposalId, input.version, actor, idempotencyKey);
    res.status(200).json({ data: proposal });
  } catch (err) {
    next(err);
  }
}

// No supplier-side accept route this session -- Accept is owner-only in v1
// (only the authenticated owner side can commit changes into
// purchase_order_items), per the locked default.

export async function rejectProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const { proposalId } = proposalIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(
      purchaseOrder.business_id,
      idempotencyKey,
      proposalService.rejectProposalEndpoint(purchaseOrder.id, proposalId)
    );
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = rejectSupplierProposalSchema.parse(req.body);
    const actor = await buildSupplierActor(req, { senderName: input.senderName, senderPhone: input.senderPhone });
    const proposal = await proposalService.rejectProposal(purchaseOrder.id, proposalId, { reason: input.reason }, actor, idempotencyKey);
    res.status(200).json({ data: proposal });
  } catch (err) {
    next(err);
  }
}

export async function listProposals(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const query = listProposalsQuerySchema.parse(req.query);
    const result = await proposalService.listProposals(purchaseOrder.id, query, "supplier", purchaseOrder.business_id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function uploadAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(purchaseOrder.business_id, idempotencyKey, attachmentService.uploadAttachmentEndpoint(purchaseOrder.id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = uploadSupplierAttachmentSchema.parse(req.body);
    const actor = await buildSupplierActor(req, { senderName: input.senderName, senderPhone: input.senderPhone });
    const attachment = await attachmentService.uploadAttachment(purchaseOrder.id, input, actor, idempotencyKey);
    res.status(201).json({ data: attachment });
  } catch (err) {
    next(err);
  }
}
