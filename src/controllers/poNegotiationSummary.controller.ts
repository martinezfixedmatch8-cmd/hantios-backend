import type { Request, Response, NextFunction } from "express";
import { idParamSchema } from "../validation/common.schema";
import { setDeadlineSchema } from "../validation/poNegotiationSummary.schema";
import * as summaryService from "../services/poNegotiationSummary.service";
import { getReplayedResponse } from "../lib/idempotency";
import { unauthorized } from "../lib/errors";

export async function getNegotiationSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const summary = await summaryService.getNegotiationSummary(id, req.auth.businessId);
    res.status(200).json({ data: summary });
  } catch (err) {
    next(err);
  }
}

export async function setDeadline(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(req.auth.businessId, idempotencyKey, summaryService.setDeadlineEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = setDeadlineSchema.parse(req.body);
    const actor = { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
    const po = await summaryService.setDeadline(id, input.respondBy ? new Date(input.respondBy) : null, input.version, actor, idempotencyKey);
    res.status(200).json({ data: po });
  } catch (err) {
    next(err);
  }
}
