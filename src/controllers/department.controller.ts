import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createDepartmentSchema,
  listDepartmentsQuerySchema,
  updateDepartmentSchema,
  archiveDepartmentSchema,
  restoreDepartmentSchema,
} from "../validation/department.schema";
import { idParamSchema } from "../validation/common.schema";
import * as departmentService from "../services/department.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createDepartment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = req.idempotencyKey as string; // guaranteed by requireIdempotencyKey

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, departmentService.CREATE_DEPARTMENT_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createDepartmentSchema.parse(req.body);
    const department = await departmentService.createDepartment(input, actor, idempotencyKey);
    res.status(201).json({ data: department });
  } catch (err) {
    next(err);
  }
}

export async function listDepartments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listDepartmentsQuerySchema.parse(req.query);
    const result = await departmentService.listDepartments(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getDepartment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const department = await departmentService.getDepartment(id, req.auth.businessId);
    res.status(200).json({ data: department });
  } catch (err) {
    next(err);
  }
}

export async function updateDepartment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = updateDepartmentSchema.parse(req.body);
    const department = await departmentService.updateDepartment(id, input, actor);
    res.status(200).json({ data: department });
  } catch (err) {
    next(err);
  }
}

export async function archiveDepartment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, departmentService.archiveDepartmentEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = archiveDepartmentSchema.parse(req.body);
    const department = await departmentService.archiveDepartment(id, input, actor, idempotencyKey);
    res.status(200).json({ data: department });
  } catch (err) {
    next(err);
  }
}

export async function restoreDepartment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, departmentService.restoreDepartmentEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = restoreDepartmentSchema.parse(req.body);
    const department = await departmentService.restoreDepartment(id, input, actor, idempotencyKey);
    res.status(200).json({ data: department });
  } catch (err) {
    next(err);
  }
}
