import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { createSupplierShipmentSchema, updateSupplierShipmentEtaSchema, listShipmentsQuerySchema } from "../validation/poShipment.schema";
import * as shipmentService from "../services/poShipment.service";
import { createSupplierMilestoneSchema, listMilestonesQuerySchema } from "../validation/poDeliveryMilestone.schema";
import * as milestoneService from "../services/poDeliveryMilestone.service";
import { uploadSupplierShipmentAttachmentSchema } from "../validation/poShipmentAttachment.schema";
import * as attachmentService from "../services/poShipmentAttachment.service";
import { getReplayedResponse } from "../lib/idempotency";
import { buildSupplierActor } from "../lib/negotiationActor";

function getSecureLink(req: Request) {
  // secureLinkAuth guarantees this is set on every route in this router --
  // not re-checked here, mirroring how the PO Negotiation portal controller
  // already trusts it once past that middleware.
  return req.secureLink!;
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

const shipmentIdParamSchema = z.object({ shipmentId: z.string().uuid() });

export async function createShipment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(purchaseOrder.business_id, idempotencyKey, shipmentService.createShipmentEndpoint(purchaseOrder.id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createSupplierShipmentSchema.parse(req.body);
    const actor = await buildSupplierActor(req, { senderName: input.senderName, senderPhone: input.senderPhone });
    const result = await shipmentService.createShipment(purchaseOrder.id, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listShipments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const query = listShipmentsQuerySchema.parse(req.query);
    const result = await shipmentService.listShipments(purchaseOrder.id, query, purchaseOrder.business_id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateShipmentEta(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const { shipmentId } = shipmentIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(
      purchaseOrder.business_id,
      idempotencyKey,
      shipmentService.updateShipmentEtaEndpoint(purchaseOrder.id, shipmentId)
    );
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = updateSupplierShipmentEtaSchema.parse(req.body);
    const actor = await buildSupplierActor(req, { senderName: input.senderName, senderPhone: input.senderPhone });
    const result = await shipmentService.updateShipmentEta(purchaseOrder.id, shipmentId, input, actor, idempotencyKey);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function uploadShipmentAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const { shipmentId } = shipmentIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(
      purchaseOrder.business_id,
      idempotencyKey,
      attachmentService.uploadShipmentAttachmentEndpoint(purchaseOrder.id, shipmentId)
    );
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = uploadSupplierShipmentAttachmentSchema.parse(req.body);
    const actor = await buildSupplierActor(req, { senderName: input.senderName, senderPhone: input.senderPhone });
    const result = await attachmentService.uploadShipmentAttachment(purchaseOrder.id, shipmentId, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function createMilestone(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(purchaseOrder.business_id, idempotencyKey, milestoneService.createMilestoneEndpoint(purchaseOrder.id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createSupplierMilestoneSchema.parse(req.body);
    const actor = await buildSupplierActor(req, { senderName: input.senderName, senderPhone: input.senderPhone });
    const result = await milestoneService.createMilestone(purchaseOrder.id, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listMilestones(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purchaseOrder } = getSecureLink(req);
    const query = listMilestonesQuerySchema.parse(req.query);
    const result = await milestoneService.listMilestones(purchaseOrder.id, query, purchaseOrder.business_id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

