import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { uploadOwnerShipmentAttachmentSchema } from "../validation/poShipmentAttachment.schema";
import { paginationQuerySchema } from "../lib/pagination";
import * as service from "../services/poShipmentAttachment.service";
import { getReplayedResponse } from "../lib/idempotency";
import { getOwnerNegotiationActor } from "../lib/negotiationActor";
import { unauthorized } from "../lib/errors";

const shipmentIdParamSchema = z.object({ id: z.string().uuid(), shipmentId: z.string().uuid() });

export async function uploadShipmentAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id, shipmentId } = shipmentIdParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.uploadShipmentAttachmentEndpoint(id, shipmentId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = uploadOwnerShipmentAttachmentSchema.parse(req.body);
    const result = await service.uploadShipmentAttachment(id, shipmentId, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listShipmentAttachments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id, shipmentId } = shipmentIdParamSchema.parse(req.params);
    const query = paginationQuerySchema.parse(req.query);
    const result = await service.listShipmentAttachments(id, shipmentId, query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
