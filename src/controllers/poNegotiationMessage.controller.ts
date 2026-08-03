import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { idParamSchema } from "../validation/common.schema";
import { createOwnerMessageSchema, listMessagesQuerySchema } from "../validation/poNegotiationMessage.schema";
import * as messageService from "../services/poNegotiationMessage.service";
import { getReplayedResponse } from "../lib/idempotency";
import { getOwnerNegotiationActor } from "../lib/negotiationActor";
import { unauthorized } from "../lib/errors";

const messageIdParamSchema = z.object({ id: z.string().uuid(), messageId: z.string().uuid() });

export async function createMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, messageService.createMessageEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createOwnerMessageSchema.parse(req.body);
    const message = await messageService.createMessage(id, input, actor, idempotencyKey);
    res.status(201).json({ data: message });
  } catch (err) {
    next(err);
  }
}

export async function listMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const query = listMessagesQuerySchema.parse(req.query);
    const result = await messageService.listMessages(id, query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function markMessageRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id, messageId } = messageIdParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, messageService.markMessageReadEndpoint(id, messageId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const message = await messageService.markMessageRead(id, messageId, actor, idempotencyKey);
    res.status(200).json({ data: message });
  } catch (err) {
    next(err);
  }
}
