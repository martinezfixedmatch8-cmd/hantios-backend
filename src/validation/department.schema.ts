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

export const listDepartmentsQuerySchema = paginationQuerySchema;
export type ListDepartmentsQuery = z.infer<typeof listDepartmentsQuerySchema>;
