import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createPurchaseOrderSchema,
  updatePurchaseOrderSchema,
  listPurchaseOrdersQuerySchema,
  sendPurchaseOrderSchema,
  confirmPurchaseOrderSchema,
  cancelPurchaseOrderSchema,
} from "../validation/purchaseOrder.schema";
import { idParamSchema } from "../validation/common.schema";
import * as purchaseOrderService from "../services/purchaseOrder.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function createPurchaseOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, purchaseOrderService.CREATE_PO_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createPurchaseOrderSchema.parse(req.body);
    const po = await purchaseOrderService.createPurchaseOrder(input, actor, idempotencyKey);
    res.status(201).json({ data: po });
  } catch (err) {
    next(err);
  }
}

export async function listPurchaseOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listPurchaseOrdersQuerySchema.parse(req.query);
    const result = await purchaseOrderService.listPurchaseOrders(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPurchaseOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const po = await purchaseOrderService.getPurchaseOrder(id, req.auth.businessId);
    res.status(200).json({ data: po });
  } catch (err) {
    next(err);
  }
}

export async function updatePurchaseOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = updatePurchaseOrderSchema.parse(req.body);
    const po = await purchaseOrderService.updatePurchaseOrder(id, input, actor);
    res.status(200).json({ data: po });
  } catch (err) {
    next(err);
  }
}

export async function sendPurchaseOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, purchaseOrderService.sendPurchaseOrderEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = sendPurchaseOrderSchema.parse(req.body);
    const po = await purchaseOrderService.sendPurchaseOrder(id, input, actor, idempotencyKey);
    res.status(200).json({ data: po });
  } catch (err) {
    next(err);
  }
}

export async function confirmPurchaseOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, purchaseOrderService.confirmPurchaseOrderEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = confirmPurchaseOrderSchema.parse(req.body);
    const po = await purchaseOrderService.confirmPurchaseOrder(id, input, actor, idempotencyKey);
    res.status(200).json({ data: po });
  } catch (err) {
    next(err);
  }
}

export async function cancelPurchaseOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, purchaseOrderService.cancelPurchaseOrderEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = cancelPurchaseOrderSchema.parse(req.body);
    const po = await purchaseOrderService.cancelPurchaseOrder(id, input, actor, idempotencyKey);
    res.status(200).json({ data: po });
  } catch (err) {
    next(err);
  }
}
