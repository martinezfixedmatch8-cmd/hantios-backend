import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

const PAYMENT_TERMS_VALUES = ["prepayment", "net_30", "net_60", "net_90"] as const;

export const createSupplierSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(30).optional(),
  email: z.string().trim().email().max(200).optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
  // Session 2A -- the supplier's own default/quoted terms. Optional: a
  // supplier can exist with no terms configured yet, same as every other
  // genuinely-optional field on this model.
  paymentTerms: z.enum(PAYMENT_TERMS_VALUES).optional(),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

// Nullable (not just optional) on every genuinely-clearable field -- same
// QA-fixed pattern Expenses'/Customers' update schemas already established:
// .optional() alone accepts omission but not an explicit null, so there'd
// be no way to ever clear a previously-set phone/email/notes.
export const updateSupplierSchema = z.object({
  version: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(1).max(30).optional().nullable(),
  email: z.string().trim().email().max(200).optional().nullable(),
  notes: z.string().trim().min(1).max(2000).optional().nullable(),
  paymentTerms: z.enum(PAYMENT_TERMS_VALUES).optional().nullable(),
});
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export const archiveSupplierSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type ArchiveSupplierInput = z.infer<typeof archiveSupplierSchema>;

export const restoreSupplierSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type RestoreSupplierInput = z.infer<typeof restoreSupplierSchema>;

export const listSuppliersQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;
