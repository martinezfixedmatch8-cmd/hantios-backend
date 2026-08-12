import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { createPositionSchema, listPositionsQuerySchema } from "../validation/position.schema";
import * as positionService from "../services/position.service";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createPosition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const input = createPositionSchema.parse(req.body);
    const result = await positionService.createPosition(input, actor);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listPositions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const query = listPositionsQuerySchema.parse(req.query);
    const result = await positionService.listPositions(query, actor.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
