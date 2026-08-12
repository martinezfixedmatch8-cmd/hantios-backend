import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  listEmployeesQuerySchema,
  archiveEmployeeSchema,
  restoreEmployeeSchema,
} from "../validation/employee.schema";
import { idParamSchema } from "../validation/common.schema";
import * as employeeService from "../services/employee.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function createEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, employeeService.CREATE_EMPLOYEE_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createEmployeeSchema.parse(req.body);
    const employee = await employeeService.createEmployee(input, actor, idempotencyKey);
    res.status(201).json({ data: employee });
  } catch (err) {
    next(err);
  }
}

export async function listEmployees(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listEmployeesQuerySchema.parse(req.query);
    const result = await employeeService.listEmployees(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const employee = await employeeService.getEmployee(id, req.auth.businessId);
    res.status(200).json({ data: employee });
  } catch (err) {
    next(err);
  }
}

export async function updateEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = updateEmployeeSchema.parse(req.body);
    const employee = await employeeService.updateEmployee(id, input, actor);
    res.status(200).json({ data: employee });
  } catch (err) {
    next(err);
  }
}

export async function archiveEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, employeeService.archiveEmployeeEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = archiveEmployeeSchema.parse(req.body);
    const employee = await employeeService.archiveEmployee(id, input, actor, idempotencyKey);
    res.status(200).json({ data: employee });
  } catch (err) {
    next(err);
  }
}

export async function restoreEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = restoreEmployeeSchema.parse(req.body);
    const employee = await employeeService.restoreEmployee(id, input, actor);
    res.status(200).json({ data: employee });
  } catch (err) {
    next(err);
  }
}
