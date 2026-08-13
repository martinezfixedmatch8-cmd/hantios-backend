import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { idParamSchema } from "../validation/common.schema";
import {
  markPayrollPaidSchema,
  bulkPayPendingSchema,
  generatePayrollSchema,
  listPayrollQuerySchema,
  createPayrollReversalSchema,
} from "../validation/payroll.schema";
import * as payrollService from "../services/payroll.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function listPayrollRecords(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listPayrollQuerySchema.parse(req.query);
    const result = await payrollService.listPayrollRecords(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPayrollRecord(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const result = await payrollService.getPayrollRecord(id, req.auth.businessId);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function markPayrollPaid(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, payrollService.markPayrollPaidEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = markPayrollPaidSchema.parse(req.body);
    const result = await payrollService.markPayrollPaid(id, input, actor, idempotencyKey);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function bulkPayPending(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, payrollService.BULK_PAY_PENDING_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = bulkPayPendingSchema.parse(req.body);
    const result = await payrollService.bulkPayPending(input, actor, idempotencyKey);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

// No Idempotency-Key -- naturally idempotent (atomic INSERT ... ON
// CONFLICT DO NOTHING underneath), same reasoning as Customers'/Suppliers'
// own restore endpoints being safe without one.
export async function generatePayroll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const input = generatePayrollSchema.parse(req.body);
    const result = await payrollService.generatePayrollHandler(actor.businessId, input.periodYear, input.periodMonth);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

// Module 12 Session D, Locked Decision #3.
export async function createPayrollReversal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, payrollService.createPayrollReversalEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createPayrollReversalSchema.parse(req.body);
    const result = await payrollService.createPayrollReversal(id, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}
