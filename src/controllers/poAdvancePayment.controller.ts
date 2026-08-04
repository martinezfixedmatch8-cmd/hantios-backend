import type { Request, Response, NextFunction } from "express";
import { idParamSchema } from "../validation/common.schema";
import { recordAdvancePaymentSchema, listAdvancePaymentsQuerySchema } from "../validation/poAdvancePayment.schema";
import * as service from "../services/poAdvancePayment.service";
import { getReplayedResponse } from "../lib/idempotency";
import { unauthorized } from "../lib/errors";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function recordAdvancePayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.recordAdvancePaymentEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = recordAdvancePaymentSchema.parse(req.body);
    const result = await service.recordAdvancePayment(id, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listAdvancePayments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const query = listAdvancePaymentsQuerySchema.parse(req.query);
    const result = await service.listAdvancePayments(id, query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
