import { z } from "zod";
import { AdjustmentType, PackagingLevel } from "@prisma/client";
import { paginationQuerySchema } from "../lib/pagination";
import { decimalField } from "./common.schema";

// images is deliberately not exposed anywhere here -- it's a dormant field
// (no upload feature exists yet, per CLAUDE.md), so there's no meaningful way
// for a client to populate it. It stays at its DB default ("[]").

// Deliberately NOT reused between create and update: sizes/unitType/packagingHierarchy
// carry `.default(...)` here for creation (a brand-new product should start with sane
// empty values), but a defaulted field still fires its default for an omitted key even
// after `.partial()` -- Zod's `.default()` substitutes whenever the resolved value would
// be undefined, regardless of whether that's "explicitly undefined" or "key not present".
// Reusing this object for updateProductSchema silently coerced every partial PATCH that
// didn't resend these three fields back to [] / "each" / {} -- a real data-loss bug QA
// caught. updateProductSchema below defines its own non-defaulted versions instead.
const createOnlyFields = {
  sizes: z.array(z.string().trim().min(1)).optional().default([]),
  unitType: z.string().trim().min(1).max(50).optional().default("each"),
  packagingHierarchy: z.record(z.string(), z.number().positive()).optional().default({}),
};

const sharedFields = {
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().max(100).optional(),
  barcode: z.string().trim().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  costPrice: decimalField(z.coerce.number().nonnegative()),
  sellingPrice: decimalField(z.coerce.number().nonnegative()),
  minStockLevel: decimalField(z.coerce.number().nonnegative()).optional(),
};

export const createProductSchema = z.object({ ...sharedFields, ...createOnlyFields });
export type CreateProductInput = z.infer<typeof createProductSchema>;

// version is required (not optional) -- optimistic locking only works if the
// client always proves which revision it last read. reason is validated as
// present-or-absent here; whether it's REQUIRED depends on whether costPrice
// is actually changing, which the schema can't know -- enforced in the service.
export const updateProductSchema = z
  .object(sharedFields)
  .partial()
  .extend({
    sizes: z.array(z.string().trim().min(1)).optional(),
    unitType: z.string().trim().min(1).max(50).optional(),
    packagingHierarchy: z.record(z.string(), z.number().positive()).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    version: z.number().int().nonnegative(),
  });
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const versionedActionSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type VersionedActionInput = z.infer<typeof versionedActionSchema>;

export const listProductsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
  categoryId: z.string().uuid().optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

// direction is supplied explicitly by the client rather than inferred from
// adjustmentType -- correction/opening_balance/transfer don't have an
// unambiguous inherent direction the way increase/decrease/damage/loss/found
// do, so guessing would bake in an unstated assumption. adjustmentType is
// kept purely as descriptive metadata (why), direction is what's authoritative
// for which way the quantity actually moves.
export const adjustStockSchema = z.object({
  branchId: z.string().uuid(),
  size: z.string().trim().min(1).optional(),
  quantity: decimalField(z.coerce.number().positive()),
  direction: z.enum(["increase", "decrease"]),
  adjustmentType: z.nativeEnum(AdjustmentType),
  packagingLevel: z.nativeEnum(PackagingLevel).optional().default("each"),
  reason: z.string().trim().min(1).max(500),
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
