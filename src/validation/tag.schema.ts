import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(50),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const listTagsQuerySchema = paginationQuerySchema;
export type ListTagsQuery = z.infer<typeof listTagsQuerySchema>;
