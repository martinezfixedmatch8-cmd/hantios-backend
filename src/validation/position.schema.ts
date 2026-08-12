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
});
export type ListPositionsQuery = z.infer<typeof listPositionsQuerySchema>;
