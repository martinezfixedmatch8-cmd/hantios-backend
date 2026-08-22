import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(50),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const listTagsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type ListTagsQuery = z.infer<typeof listTagsQuerySchema>;

// Batch 6 (HNT2-MASTER-001) -- controlled rename/archive/restore. Exact-
// match name comparison preserved (no case/whitespace normalization added
// -- deliberately different from departments/positions).
export const updateTagSchema = z.object({
  version: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(50),
});
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export const archiveTagSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type ArchiveTagInput = z.infer<typeof archiveTagSchema>;

export const restoreTagSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type RestoreTagInput = z.infer<typeof restoreTagSchema>;
