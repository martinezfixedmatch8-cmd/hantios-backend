import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { stockInSchema, stockOutSchema } from "../validation/warehouseMovement.schema";
import * as warehouseMovementService from "../services/warehouseMovement.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function stockIn(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, warehouseMovementService.STOCK_IN_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = stockInSchema.parse(req.body);
    const movement = await warehouseMovementService.stockIn(input, actor, idempotencyKey);
    res.status(201).json({ data: movement });
  } catch (err) {
    next(err);
  }
}

export async function stockOut(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, warehouseMovementService.STOCK_OUT_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = stockOutSchema.parse(req.body);
    const movement = await warehouseMovementService.stockOut(input, actor, idempotencyKey);
    res.status(201).json({ data: movement });
  } catch (err) {
    next(err);
  }
}
