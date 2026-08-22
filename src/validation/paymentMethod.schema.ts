import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

export const createPaymentMethodSchema = z.object({
  name: z.string().trim().min(1).max(150),
  logoUrl: z.string().trim().url().max(500).optional(),
  accountNumber: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
});
export type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodSchema>;

// Batch 6 (HNT2-MD-001) -- version is now required on every mutation.
export const updatePaymentMethodSchema = createPaymentMethodSchema.partial().extend({
  version: z.number().int().nonnegative(),
});
export type UpdatePaymentMethodInput = z.infer<typeof updatePaymentMethodSchema>;

export const archivePaymentMethodSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type ArchivePaymentMethodInput = z.infer<typeof archivePaymentMethodSchema>;

export const restorePaymentMethodSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type RestorePaymentMethodInput = z.infer<typeof restorePaymentMethodSchema>;

export const listPaymentMethodsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type ListPaymentMethodsQuery = z.infer<typeof listPaymentMethodsQuerySchema>;
