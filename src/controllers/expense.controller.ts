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

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, expenseService.CREATE_EXPENSE_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createExpenseSchema.parse(req.body);
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

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, expenseService.updateExpenseEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = updateExpenseSchema.parse(req.body);
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

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, expenseService.archiveExpenseEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = archiveExpenseSchema.parse(req.body);
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

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, expenseService.restoreExpenseEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = restoreExpenseSchema.parse(req.body);
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

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, expenseService.addAttachmentsEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = addAttachmentsSchema.parse(req.body);
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

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, expenseService.deleteAttachmentEndpoint(id, attachmentId));
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

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, expenseService.approveExpenseEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = approveExpenseSchema.parse(req.body);
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

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, expenseService.rejectExpenseEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = rejectExpenseSchema.parse(req.body);
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

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, expenseService.markPaidExpenseEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = markPaidExpenseSchema.parse(req.body);
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

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, expenseService.updateRecurrenceEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = updateRecurrenceSchema.parse(req.body);
    const recurrence = await expenseService.updateRecurrence(id, input, actor, idempotencyKey);
    res.status(200).json({ data: recurrence });
  } catch (err) {
    next(err);
  }
}
