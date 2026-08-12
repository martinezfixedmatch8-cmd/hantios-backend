import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { createCommissionAdjustmentSchema } from "../validation/commission.schema";
import * as commissionService from "../services/commission.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createCommissionAdjustment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = req.idempotencyKey as string; // guaranteed by requireIdempotencyKey

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, commissionService.CREATE_COMMISSION_ADJUSTMENT_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createCommissionAdjustmentSchema.parse(req.body);
    const result = await commissionService.createCommissionAdjustment(input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}
