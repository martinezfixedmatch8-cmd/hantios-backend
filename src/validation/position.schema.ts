import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

// Module 12 Session A -- same minimal, foundation-only shape as
// department.schema.ts. departmentId is optional: a position doesn't
// strictly require a department.
export const createPositionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  departmentId: z.string().uuid().optional(),
});
export type CreatePositionInput = z.infer<typeof createPositionSchema>;

export const listPositionsQuerySchema = paginationQuerySchema.extend({
  departmentId: z.string().uuid().optional(),
  status: z.enum(["active", "archived"]).optional(),
});
export type ListPositionsQuery = z.infer<typeof listPositionsQuerySchema>;

// Batch 6 (HNT2-HR-001) -- full lifecycle. departmentId is nullable (not
// just optional) on update so a position's department link can be
// explicitly cleared, matching this repo's own established
// .optional().nullable() pattern for genuinely-clearable FKs.
export const updatePositionSchema = z.object({
  version: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(200),
  departmentId: z.string().uuid().nullable().optional(),
});
export type UpdatePositionInput = z.infer<typeof updatePositionSchema>;

export const archivePositionSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type ArchivePositionInput = z.infer<typeof archivePositionSchema>;

export const restorePositionSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type RestorePositionInput = z.infer<typeof restorePositionSchema>;
