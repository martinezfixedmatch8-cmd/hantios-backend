import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { unauthorized } from "../lib/errors";
import {
  createExpenseSchema,
  updateExpenseSchema,
  listExpensesQuerySchema,
  archiveExpenseSchema,
  restoreExpenseSchema,
  addAttachmentsSchema,
  approveExpenseSchema,
  rejectExpenseSchema,
  markPaidExpenseSchema,
  updateRecurrenceSchema,
  createExpenseCorrectionSchema,
} from "../validation/expense.schema";
import { idParamSchema } from "../validation/common.schema";
import * as expenseService from "../services/expense.service";
import { getReplayedResponse } from "../lib/idempotency";

const attachmentIdParamSchema = z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() });

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function createExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const input = createExpenseSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.CREATE_EXPENSE_ENDPOINT, input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const expense = await expenseService.createExpense(input, actor, idempotencyKey);
    res.status(201).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

export async function listExpenses(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listExpensesQuerySchema.parse(req.query);
    const result = await expenseService.listExpenses(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const expense = await expenseService.getExpense(id, req.auth.businessId);
    res.status(200).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

export async function updateExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const input = updateExpenseSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.updateExpenseEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const expense = await expenseService.updateExpense(id, input, actor, idempotencyKey);
    res.status(200).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

export async function archiveExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const input = archiveExpenseSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.archiveExpenseEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const expense = await expenseService.archiveExpense(id, input, actor, idempotencyKey);
    res.status(200).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

export async function restoreExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const input = restoreExpenseSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.restoreExpenseEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const expense = await expenseService.restoreExpense(id, input, actor, idempotencyKey);
    res.status(200).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

export async function addAttachments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const input = addAttachmentsSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.addAttachmentsEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const expense = await expenseService.addAttachments(id, input, actor, idempotencyKey);
    res.status(201).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

export async function deleteAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id, attachmentId } = attachmentIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.deleteAttachmentEndpoint(id, attachmentId), {});
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const expense = await expenseService.deleteAttachment(id, attachmentId, actor, idempotencyKey);
    res.status(200).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

export async function approveExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const input = approveExpenseSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.approveExpenseEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const expense = await expenseService.approveExpense(id, input, actor, idempotencyKey);
    res.status(200).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

export async function rejectExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const input = rejectExpenseSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.rejectExpenseEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const expense = await expenseService.rejectExpense(id, input, actor, idempotencyKey);
    res.status(200).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

export async function markExpensePaid(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const input = markPaidExpenseSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.markPaidExpenseEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const expense = await expenseService.markExpensePaid(id, input, actor, idempotencyKey);
    res.status(200).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

export async function updateRecurrence(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const input = updateRecurrenceSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.updateRecurrenceEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const recurrence = await expenseService.updateRecurrence(id, input, actor, idempotencyKey);
    res.status(200).json({ data: recurrence });
  } catch (err) {
    next(err);
  }
}

// HNT-FIN-001 remediation.
export async function createExpenseCorrection(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const input = createExpenseCorrectionSchema.parse(req.body);

    const replayed = await getReplayedResponse(actor.businessId, actor.userId, idempotencyKey, expenseService.createExpenseCorrectionEndpoint(id), input);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const correction = await expenseService.createExpenseCorrection(id, input, actor, idempotencyKey);
    res.status(201).json({ data: correction });
  } catch (err) {
    next(err);
  }
}
