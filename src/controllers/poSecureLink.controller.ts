import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { idParamSchema } from "../validation/common.schema";
import * as poSecureLinkService from "../services/poSecureLink.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function regenerateSecureLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, poSecureLinkService.regenerateSecureLinkEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const link = await poSecureLinkService.regenerateSecureLink(id, actor, idempotencyKey);
    res.status(201).json({ data: link });
  } catch (err) {
    next(err);
  }
}

export async function revokeSecureLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, poSecureLinkService.revokeSecureLinkEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const link = await poSecureLinkService.revokeSecureLink(id, actor, idempotencyKey);
    res.status(200).json({ data: link });
  } catch (err) {
    next(err);
  }
}
