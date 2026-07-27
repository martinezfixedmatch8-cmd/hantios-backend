import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { createTagSchema, listTagsQuerySchema } from "../validation/tag.schema";
import * as tagService from "../services/tag.service";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createTag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const input = createTagSchema.parse(req.body);
    const tag = await tagService.createTag(input, actor);
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
