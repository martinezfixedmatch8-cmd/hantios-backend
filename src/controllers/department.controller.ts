import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { createDepartmentSchema, listDepartmentsQuerySchema } from "../validation/department.schema";
import * as departmentService from "../services/department.service";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createDepartment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const input = createDepartmentSchema.parse(req.body);
    const result = await departmentService.createDepartment(input, actor);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listDepartments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const query = listDepartmentsQuerySchema.parse(req.query);
    const result = await departmentService.listDepartments(query, actor.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
