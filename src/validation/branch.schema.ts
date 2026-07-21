import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

export const createBranchSchema = z.object({
  name: z.string().trim().min(1).max(150),
  location: z.string().trim().max(300).optional(),
  managerId: z.string().uuid().optional(),
});
export type CreateBranchInput = z.infer<typeof createBranchSchema>;

export const updateBranchSchema = createBranchSchema.partial();
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;

export const listBranchesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type ListBranchesQuery = z.infer<typeof listBranchesQuerySchema>;
