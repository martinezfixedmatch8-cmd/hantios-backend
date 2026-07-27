import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
  listExpenseCategoriesQuerySchema,
} from "../validation/expenseCategory.schema";
import { idParamSchema } from "../validation/common.schema";
import * as expenseCategoryService from "../services/expenseCategory.service";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createExpenseCategory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const input = createExpenseCategorySchema.parse(req.body);
    const category = await expenseCategoryService.createExpenseCategory(input, actor);
    res.status(201).json({ data: category });
  } catch (err) {
    next(err);
  }
}

export async function listExpenseCategories(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listExpenseCategoriesQuerySchema.parse(req.query);
    const result = await expenseCategoryService.listExpenseCategories(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateExpenseCategory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = updateExpenseCategorySchema.parse(req.body);
    const category = await expenseCategoryService.updateExpenseCategory(id, input, actor);
    res.status(200).json({ data: category });
  } catch (err) {
    next(err);
  }
}

export async function deactivateExpenseCategory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const category = await expenseCategoryService.deactivateExpenseCategory(id, actor);
    res.status(200).json({ data: category });
  } catch (err) {
    next(err);
  }
}
