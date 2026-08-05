import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { idParamSchema } from "../validation/common.schema";
import {
  createShipmentSchema,
  updateShipmentStatusSchema,
  updateShipmentSchema,
  updateShipmentEtaSchema,
  listShipmentsQuerySchema,
} from "../validation/poShipment.schema";
import * as service from "../services/poShipment.service";
import { getReplayedResponse } from "../lib/idempotency";
import { getOwnerNegotiationActor } from "../lib/negotiationActor";
import { unauthorized } from "../lib/errors";

const shipmentIdParamSchema = z.object({ id: z.string().uuid(), shipmentId: z.string().uuid() });

export async function createShipment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.createShipmentEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createShipmentSchema.parse(req.body);
    const result = await service.createShipment(id, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listShipments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const query = listShipmentsQuerySchema.parse(req.query);
    const result = await service.listShipments(id, query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getShipment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id, shipmentId } = shipmentIdParamSchema.parse(req.params);
    const result = await service.getShipment(id, shipmentId, req.auth.businessId);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateShipmentStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id, shipmentId } = shipmentIdParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.updateShipmentStatusEndpoint(id, shipmentId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = updateShipmentStatusSchema.parse(req.body);
    const result = await service.updateShipmentStatus(id, shipmentId, input, actor, idempotencyKey);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateShipment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id, shipmentId } = shipmentIdParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.updateShipmentEndpoint(id, shipmentId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = updateShipmentSchema.parse(req.body);
    const result = await service.updateShipment(id, shipmentId, input, actor, idempotencyKey);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateShipmentEta(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id, shipmentId } = shipmentIdParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.updateShipmentEtaEndpoint(id, shipmentId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = updateShipmentEtaSchema.parse(req.body);
    const result = await service.updateShipmentEta(id, shipmentId, input, actor, idempotencyKey);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function getRemainingQuantities(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id, shipmentId } = shipmentIdParamSchema.parse(req.params);
    const result = await service.getRemainingQuantities(id, shipmentId, req.auth.businessId);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}
