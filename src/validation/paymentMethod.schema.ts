import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

export const createPaymentMethodSchema = z.object({
  name: z.string().trim().min(1).max(150),
  logoUrl: z.string().trim().url().max(500).optional(),
  accountNumber: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
});
export type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodSchema>;

export const updatePaymentMethodSchema = createPaymentMethodSchema.partial();
export type UpdatePaymentMethodInput = z.infer<typeof updatePaymentMethodSchema>;

export const listPaymentMethodsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type ListPaymentMethodsQuery = z.infer<typeof listPaymentMethodsQuerySchema>;
