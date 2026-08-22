import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

// Module 12 Session A -- plain business-managed reference data, same
// minimal shape as categories.schema.ts (create + list only; "no
// department-management UI workflow" per the confirmed addendum -- no
// update/archive endpoints this session).
export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

export const listDepartmentsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type ListDepartmentsQuery = z.infer<typeof listDepartmentsQuerySchema>;

// Batch 6 (HNT2-HR-001) -- full lifecycle.
export const updateDepartmentSchema = z.object({
  version: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(200),
});
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;

export const archiveDepartmentSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type ArchiveDepartmentInput = z.infer<typeof archiveDepartmentSchema>;

export const restoreDepartmentSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type RestoreDepartmentInput = z.infer<typeof restoreDepartmentSchema>;
