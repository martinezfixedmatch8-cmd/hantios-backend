import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

// `type` is never client-suppliable here -- system categories are seeded
// internally (see ensureSystemCategoriesSeeded in expenseCategory.service.ts),
// never created through this endpoint. Every category this schema can create
// is implicitly "custom".
export const createExpenseCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().trim().max(20).optional(),
});
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

export const updateExpenseCategorySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  color: z.string().trim().max(20).optional(),
});
export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;

export const listExpenseCategoriesQuerySchema = paginationQuerySchema.extend({
  active: z.coerce.boolean().optional(),
});
export type ListExpenseCategoriesQuery = z.infer<typeof listExpenseCategoriesQuerySchema>;
