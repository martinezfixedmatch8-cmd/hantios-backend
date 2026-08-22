import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createPositionSchema,
  listPositionsQuerySchema,
  updatePositionSchema,
  archivePositionSchema,
  restorePositionSchema,
} from "../validation/position.schema";
import { idParamSchema } from "../validation/common.schema";
import * as positionService from "../services/position.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createPosition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, positionService.CREATE_POSITION_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createPositionSchema.parse(req.body);
    const position = await positionService.createPosition(input, actor, idempotencyKey);
    res.status(201).json({ data: position });
  } catch (err) {
    next(err);
  }
}

export async function listPositions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listPositionsQuerySchema.parse(req.query);
    const result = await positionService.listPositions(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPosition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const position = await positionService.getPosition(id, req.auth.businessId);
    res.status(200).json({ data: position });
  } catch (err) {
    next(err);
  }
}

export async function updatePosition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = updatePositionSchema.parse(req.body);
    const position = await positionService.updatePosition(id, input, actor);
    res.status(200).json({ data: position });
  } catch (err) {
    next(err);
  }
}

export async function archivePosition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, positionService.archivePositionEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = archivePositionSchema.parse(req.body);
    const position = await positionService.archivePosition(id, input, actor, idempotencyKey);
    res.status(200).json({ data: position });
  } catch (err) {
    next(err);
  }
}

export async function restorePosition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, positionService.restorePositionEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = restorePositionSchema.parse(req.body);
    const position = await positionService.restorePosition(id, input, actor, idempotencyKey);
    res.status(200).json({ data: position });
  } catch (err) {
    next(err);
  }
}
