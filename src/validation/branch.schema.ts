import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

export const createBranchSchema = z.object({
  name: z.string().trim().min(1).max(150),
  location: z.string().trim().max(300).optional(),
  managerId: z.string().uuid().optional(),
});
export type CreateBranchInput = z.infer<typeof createBranchSchema>;

// Batch 6 (HNT2-MD-001) -- version is now required on every mutation.
export const updateBranchSchema = createBranchSchema.partial().extend({
  version: z.number().int().nonnegative(),
});
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;

export const archiveBranchSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type ArchiveBranchInput = z.infer<typeof archiveBranchSchema>;

export const restoreBranchSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type RestoreBranchInput = z.infer<typeof restoreBranchSchema>;

export const listBranchesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type ListBranchesQuery = z.infer<typeof listBranchesQuerySchema>;
