import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

// Module 12 Session A. Position (departmentId/positionId) is a real,
// business-managed reference lookup, deliberately never conflated with
// RBAC role -- see departments/positions.schema.ts. Both nullable per the
// confirmed addendum (not every business will have set these up yet).
export const createEmployeeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(30),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

// Nullable (not just optional) on every genuinely-clearable field -- same
// QA-fixed pattern Expenses'/Customers'/Suppliers' own update schemas
// already established: .optional() alone accepts omission but not an
// explicit null, so there'd be no way to ever clear a previously-set
// branch/department/position.
export const updateEmployeeSchema = z.object({
  version: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(1).max(30).optional(),
  branchId: z.string().uuid().optional().nullable(),
  departmentId: z.string().uuid().optional().nullable(),
  positionId: z.string().uuid().optional().nullable(),
});
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const archiveEmployeeSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type ArchiveEmployeeInput = z.infer<typeof archiveEmployeeSchema>;

export const restoreEmployeeSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type RestoreEmployeeInput = z.infer<typeof restoreEmployeeSchema>;

export const listEmployeesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
});
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;
