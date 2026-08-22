import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createTagSchema,
  listTagsQuerySchema,
  updateTagSchema,
  archiveTagSchema,
  restoreTagSchema,
} from "../validation/tag.schema";
import { idParamSchema } from "../validation/common.schema";
import * as tagService from "../services/tag.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createTag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, tagService.CREATE_TAG_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createTagSchema.parse(req.body);
    const tag = await tagService.createTag(input, actor, idempotencyKey);
    res.status(201).json({ data: tag });
  } catch (err) {
    next(err);
  }
}

export async function listTags(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listTagsQuerySchema.parse(req.query);
    const result = await tagService.listTags(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getTag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const tag = await tagService.getTag(id, req.auth.businessId);
    res.status(200).json({ data: tag });
  } catch (err) {
    next(err);
  }
}

export async function updateTag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = updateTagSchema.parse(req.body);
    const tag = await tagService.updateTag(id, input, actor);
    res.status(200).json({ data: tag });
  } catch (err) {
    next(err);
  }
}

export async function archiveTag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, tagService.archiveTagEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = archiveTagSchema.parse(req.body);
    const tag = await tagService.archiveTag(id, input, actor, idempotencyKey);
    res.status(200).json({ data: tag });
  } catch (err) {
    next(err);
  }
}

export async function restoreTag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, tagService.restoreTagEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = restoreTagSchema.parse(req.body);
    const tag = await tagService.restoreTag(id, input, actor, idempotencyKey);
    res.status(200).json({ data: tag });
  } catch (err) {
    next(err);
  }
}
