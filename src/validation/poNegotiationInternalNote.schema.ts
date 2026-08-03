import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

export const createInternalNoteSchema = z.object({
  noteText: z.string().trim().min(1).max(5000),
});
export type CreateInternalNoteInput = z.infer<typeof createInternalNoteSchema>;

export const listInternalNotesQuerySchema = paginationQuerySchema;
export type ListInternalNotesQuery = z.infer<typeof listInternalNotesQuerySchema>;
