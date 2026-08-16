// HNT-INV-001 remediation -- branch_inventory.size used to be written as a
// real NULL for "no size," but Postgres never matches NULL = NULL inside a
// unique index, so @@unique([branch_id, product_id, size]) silently failed
// to dedupe every no-size product (the overwhelming majority of real
// usage). Fixed the exact same way warehouse_stock's own identical gap was
// already fixed (Module 11 Session B): normalize "no size" to a canonical
// empty string instead, making the existing unique index a real, enforced
// guard. The column stays nullable at the Prisma/DB type level (matching
// warehouse_stock's own precedent exactly) -- what matters is that no
// application code path ever WRITES or QUERIES an actual null again.
//
// Every read/write site touching branch_inventory.size must run the raw
// client-or-snapshot value through this exact normalizer, never compare
// against `null` directly -- see product.service.ts's adjustProductStock
// and sale.service.ts's createSale/voidSale/refundSale for the real call
// sites (confirmed via exhaustive search, 2026-08-16).
export const NO_SIZE = "";

export function normalizeSize(size: string | null | undefined): string {
  return size ?? NO_SIZE;
}
