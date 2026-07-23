import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { unauthorized } from "../lib/errors";
import {
  createDebtSchema,
  listDebtsQuerySchema,
  recordPaymentSchema,
  reversePaymentSchema,
  debtStatusActionSchema,
} from "../validation/debt.schema";
import { idParamSchema } from "../validation/common.schema";
import * as debtService from "../services/debt.service";
import { getReplayedResponse } from "../lib/idempotency";

const paymentIdParamSchema = z.object({ id: z.string().uuid(), paymentId: z.string().uuid() });

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function createDebt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, debtService.CREATE_DEBT_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createDebtSchema.parse(req.body);
    const debt = await debtService.createDebt(input, actor, idempotencyKey);
    res.status(201).json({ data: debt });
  } catch (err) {
    next(err);
  }
}

export async function listDebts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listDebtsQuerySchema.parse(req.query);
    const result = await debtService.listDebts(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getDebt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const debt = await debtService.getDebt(id, req.auth.businessId);
    res.status(200).json({ data: debt });
  } catch (err) {
    next(err);
  }
}

export async function recordPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, debtService.recordPaymentEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = recordPaymentSchema.parse(req.body);
    const payment = await debtService.recordPayment(id, input, actor, idempotencyKey);
    res.status(201).json({ data: payment });
  } catch (err) {
    next(err);
  }
}

export async function reversePayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id, paymentId } = paymentIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, debtService.reversePaymentEndpoint(id, paymentId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = reversePaymentSchema.parse(req.body);
    const reversal = await debtService.reversePayment(id, paymentId, input, actor, idempotencyKey);
    res.status(201).json({ data: reversal });
  } catch (err) {
    next(err);
  }
}

export async function disputeDebt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, `POST /debts/${id}/dispute`);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = debtStatusActionSchema.parse(req.body);
    const debt = await debtService.disputeDebt(id, input, actor, idempotencyKey);
    res.status(200).json({ data: debt });
  } catch (err) {
    next(err);
  }
}

export async function resolveDisputeDebt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, `POST /debts/${id}/resolve-dispute`);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = debtStatusActionSchema.parse(req.body);
    const debt = await debtService.resolveDisputeDebt(id, input, actor, idempotencyKey);
    res.status(200).json({ data: debt });
  } catch (err) {
    next(err);
  }
}

export async function writeOffDebt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, debtService.writeOffEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = debtStatusActionSchema.parse(req.body);
    const debt = await debtService.writeOffDebt(id, input, actor, idempotencyKey);
    res.status(200).json({ data: debt });
  } catch (err) {
    next(err);
  }
}

export async function sendReminder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const reminder = await debtService.sendReminder(id, actor);
    res.status(201).json({ data: reminder });
  } catch (err) {
    next(err);
  }
}
