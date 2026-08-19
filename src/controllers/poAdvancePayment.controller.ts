import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { idParamSchema } from "../validation/common.schema";
import { recordAdvancePaymentSchema, listAdvancePaymentsQuerySchema, reverseAdvancePaymentSchema } from "../validation/poAdvancePayment.schema";
import * as service from "../services/poAdvancePayment.service";
import { getReplayedResponse } from "../lib/idempotency";
import { unauthorized } from "../lib/errors";

const paymentIdParamSchema = z.object({ id: z.string().uuid(), paymentId: z.string().uuid() });

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

// Batch 4 remediation (HNT2-PO-002).
export async function reverseAdvancePayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id, paymentId } = paymentIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.reverseAdvancePaymentEndpoint(id, paymentId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = reverseAdvancePaymentSchema.parse(req.body);
    const result = await service.reverseAdvancePayment(id, paymentId, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

// No Idempotency-Key -- same reasoning as the payment-instruction reveal
// endpoint (read-shaped, the only side effect is one audit row).
export async function revealAdvancePayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id, paymentId } = paymentIdParamSchema.parse(req.params);
    const result = await service.revealAdvancePayment(id, paymentId, actor);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}
