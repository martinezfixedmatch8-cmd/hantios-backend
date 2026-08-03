import type { Request, Response, NextFunction } from "express";
import { idParamSchema } from "../validation/common.schema";
import { createInternalNoteSchema, listInternalNotesQuerySchema } from "../validation/poNegotiationInternalNote.schema";
import * as noteService from "../services/poNegotiationInternalNote.service";
import { getReplayedResponse } from "../lib/idempotency";
import { unauthorized } from "../lib/errors";

export async function createInternalNote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(req.auth.businessId, idempotencyKey, noteService.createInternalNoteEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createInternalNoteSchema.parse(req.body);
    const actor = { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
    const note = await noteService.createInternalNote(id, input, actor, idempotencyKey);
    res.status(201).json({ data: note });
  } catch (err) {
    next(err);
  }
}

export async function listInternalNotes(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const query = listInternalNotesQuerySchema.parse(req.query);
    const result = await noteService.listInternalNotes(id, query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
