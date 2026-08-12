import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { idParamSchema } from "../validation/common.schema";
import { createEmployeeCompensationSchema } from "../validation/compensation.schema";
import * as compensationService from "../services/employeeCompensation.service";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createEmployeeCompensation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = createEmployeeCompensationSchema.parse(req.body);
    const result = await compensationService.createEmployeeCompensation(id, input, actor);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listEmployeeCompensation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const result = await compensationService.listEmployeeCompensation(id, actor.businessId);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}
