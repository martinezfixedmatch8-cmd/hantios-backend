import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createPaymentMethodSchema,
  listPaymentMethodsQuerySchema,
  updatePaymentMethodSchema,
  archivePaymentMethodSchema,
  restorePaymentMethodSchema,
} from "../validation/paymentMethod.schema";
import { idParamSchema } from "../validation/common.schema";
import * as paymentMethodService from "../services/paymentMethod.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createPaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = req.idempotencyKey as string;

    const input = createPaymentMethodSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, paymentMethodService.CREATE_PAYMENT_METHOD_ENDPOINT, input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const paymentMethod = await paymentMethodService.createPaymentMethod(input, actor, idempotencyKey);
    res.status(201).json({ data: paymentMethod });
  } catch (err) {
    next(err);
  }
}

export async function listPaymentMethods(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listPaymentMethodsQuerySchema.parse(req.query);
    const result = await paymentMethodService.listPaymentMethods(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const paymentMethod = await paymentMethodService.getPaymentMethod(id, req.auth.businessId);
    res.status(200).json({ data: paymentMethod });
  } catch (err) {
    next(err);
  }
}

export async function updatePaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = updatePaymentMethodSchema.parse(req.body);
    const paymentMethod = await paymentMethodService.updatePaymentMethod(id, input, actor);
    res.status(200).json({ data: paymentMethod });
  } catch (err) {
    next(err);
  }
}

export async function archivePaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const input = archivePaymentMethodSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, paymentMethodService.archivePaymentMethodEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const paymentMethod = await paymentMethodService.archivePaymentMethod(id, input, actor, idempotencyKey);
    res.status(200).json({ data: paymentMethod });
  } catch (err) {
    next(err);
  }
}

export async function restorePaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const input = restorePaymentMethodSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, paymentMethodService.restorePaymentMethodEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const paymentMethod = await paymentMethodService.restorePaymentMethod(id, input, actor, idempotencyKey);
    res.status(200).json({ data: paymentMethod });
  } catch (err) {
    next(err);
  }
}
