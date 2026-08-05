import type { Request, Response, NextFunction } from "express";
import { idParamSchema } from "../validation/common.schema";
import { createMilestoneSchema, listMilestonesQuerySchema } from "../validation/poDeliveryMilestone.schema";
import * as service from "../services/poDeliveryMilestone.service";
import { getReplayedResponse } from "../lib/idempotency";
import { getOwnerNegotiationActor } from "../lib/negotiationActor";
import { unauthorized } from "../lib/errors";

export async function createMilestone(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.createMilestoneEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createMilestoneSchema.parse(req.body);
    const result = await service.createMilestone(id, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listMilestones(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const query = listMilestonesQuerySchema.parse(req.query);
    const result = await service.listMilestones(id, query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
