import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

export const createCustomerSchema = z.object({
  phone: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(200).optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

// Nullable (not just optional) on every genuinely-clearable field -- the
// same QA-fixed pattern Expenses' update schema already established (see
// CLAUDE.md): .optional() alone accepts omission but not an explicit null,
// so there'd be no way to ever clear a previously-set name/email/notes.
export const updateCustomerSchema = z.object({
  version: z.number().int().nonnegative(),
  phone: z.string().trim().min(1).max(30).optional(),
  name: z.string().trim().min(1).max(200).optional().nullable(),
  email: z.string().trim().email().max(200).optional().nullable(),
  notes: z.string().trim().min(1).max(2000).optional().nullable(),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const archiveCustomerSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type ArchiveCustomerInput = z.infer<typeof archiveCustomerSchema>;

export const restoreCustomerSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type RestoreCustomerInput = z.infer<typeof restoreCustomerSchema>;

export const listCustomersQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

export const customerTimelineQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type CustomerTimelineQuery = z.infer<typeof customerTimelineQuerySchema>;
