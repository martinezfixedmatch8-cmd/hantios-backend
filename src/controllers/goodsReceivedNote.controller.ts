import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { createGoodsReceivedNoteSchema } from "../validation/goodsReceivedNote.schema";
import { idParamSchema } from "../validation/common.schema";
import * as goodsReceivedNoteService from "../services/goodsReceivedNote.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function createGoodsReceivedNote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(
      actor.businessId,
      idempotencyKey,
      goodsReceivedNoteService.createGoodsReceivedNoteEndpoint(id)
    );
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createGoodsReceivedNoteSchema.parse(req.body);
    const grn = await goodsReceivedNoteService.createGoodsReceivedNote(id, input, actor, idempotencyKey);
    res.status(201).json({ data: grn });
  } catch (err) {
    next(err);
  }
}
