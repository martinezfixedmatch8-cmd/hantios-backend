import { z } from "zod";

export const idParamSchema = z.object({
  id: z.string().uuid(),
});
export type IdParam = z.infer<typeof idParamSchema>;

// All money/quantity fields across every module are stored as Decimal(14,2) --
// reject anything with finer precision than the DB can actually represent,
// rather than silently rounding (see product.schema.ts's original comment:
// QA found silent rounding produces phantom PriceHistory rows and, for
// stock-adjustment quantities, an unhandled 500 when a sub-cent amount rounds
// to 0 at write time and trips a `quantity_positive` CHECK constraint).
export function decimalField<T extends z.ZodType<number>>(base: T) {
  return base.refine((v) => Math.round(v * 100) / 100 === v, { message: "must have at most 2 decimal places" });
}
