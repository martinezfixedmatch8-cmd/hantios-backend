-- Backfills migration history for five CHECK constraints that already exist on
-- the live database (confirmed via pg_constraint) but were never captured in
-- a migration file -- a real drift from "never hand-edit the live schema
-- outside Prisma", discovered while planning the business-modules rebuild.
-- This migration is NOT executed against the current live DB (it already has
-- every constraint below) -- it is only recorded via `prisma migrate resolve
-- --applied`, so that a fresh `prisma migrate deploy` against an empty
-- database recreates them correctly. Prisma's schema DSL in this version has
-- no native CHECK constraint syntax (see the `///` warning comments already
-- on branch_inventory/debts/expenses/inventory_adjustments/sales in
-- schema.prisma) -- raw SQL is the only way to express these.

ALTER TABLE "branch_inventory" ADD CONSTRAINT "chk_branch_inventory_quantity_nonneg" CHECK (quantity >= 0);

ALTER TABLE "debts" ADD CONSTRAINT "chk_debts_amount_nonneg" CHECK (amount_original >= 0 AND amount_paid >= 0 AND amount_remaining >= 0);

ALTER TABLE "expenses" ADD CONSTRAINT "chk_expenses_amount_nonneg" CHECK (amount >= 0);

ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "chk_inventory_adj_amount_positive" CHECK (adjustment_amount > 0);

ALTER TABLE "sales" ADD CONSTRAINT "chk_sales_total_nonneg" CHECK (total >= 0 OR refund_of_sale_id IS NOT NULL);
