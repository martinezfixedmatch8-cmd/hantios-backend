import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { idParamSchema } from "../validation/common.schema";
import {
  createAttendanceRecordSchema,
  bulkCreateAttendanceSchema,
  listAttendanceQuerySchema,
  createAttendanceAdjustmentSchema,
  recordSelfAttendanceSchema,
} from "../validation/attendance.schema";
import * as attendanceService from "../services/attendance.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function recordAttendance(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, attendanceService.RECORD_ATTENDANCE_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createAttendanceRecordSchema.parse(req.body);
    const result = await attendanceService.recordAttendance(input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

// Module 12 Session D, Locked Decision #5 -- self-service, backend-only.
// Deliberately no requireRole check upstream of this handler -- see
// attendance.routes.ts's own comment.
export async function recordSelfAttendance(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, attendanceService.RECORD_SELF_ATTENDANCE_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = recordSelfAttendanceSchema.parse(req.body);
    const result = await attendanceService.recordSelfAttendance(input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function bulkRecordAttendance(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);
    const input = bulkCreateAttendanceSchema.parse(req.body);
    const result = await attendanceService.bulkRecordAttendance(input, actor, idempotencyKey);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listAttendanceRecords(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listAttendanceQuerySchema.parse(req.query);
    const result = await attendanceService.listAttendanceRecords(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getAttendanceRecord(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const result = await attendanceService.getAttendanceRecord(id, req.auth.businessId);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function createAttendanceAdjustment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, attendanceService.createAttendanceAdjustmentEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createAttendanceAdjustmentSchema.parse(req.body);
    const result = await attendanceService.createAttendanceAdjustment(id, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}
