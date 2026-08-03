import type { Request, Response, NextFunction } from "express";
import { idParamSchema } from "../validation/common.schema";
import { uploadOwnerAttachmentSchema } from "../validation/poNegotiationAttachment.schema";
import * as attachmentService from "../services/poNegotiationAttachment.service";
import { getReplayedResponse } from "../lib/idempotency";
import { getOwnerNegotiationActor } from "../lib/negotiationActor";
import { unauthorized } from "../lib/errors";

export async function uploadAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, attachmentService.uploadAttachmentEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = uploadOwnerAttachmentSchema.parse(req.body);
    const attachment = await attachmentService.uploadAttachment(id, input, actor, idempotencyKey);
    res.status(201).json({ data: attachment });
  } catch (err) {
    next(err);
  }
}
