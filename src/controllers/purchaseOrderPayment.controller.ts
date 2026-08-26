import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { recordPurchaseOrderPaymentSchema } from "../validation/purchaseOrderPayment.schema";
import { idParamSchema } from "../validation/common.schema";
import * as purchaseOrderPaymentService from "../services/purchaseOrderPayment.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function recordPurchaseOrderPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);
    const input = recordPurchaseOrderPaymentSchema.parse(req.body);

    const replayed = await getReplayedResponse(
      actor.businessId,
      actor.userId,
      idempotencyKey,
      purchaseOrderPaymentService.recordPurchaseOrderPaymentEndpoint(id),
      input
    );
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const result = await purchaseOrderPaymentService.recordPurchaseOrderPayment(id, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}
