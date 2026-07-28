-- Low Stock Alert (Module 02 completion): persisted per-row debounce state
-- on branch_inventory, written atomically in the same transaction as the
-- quantity change that crosses the threshold -- not a query against event/
-- audit history. See CLAUDE.md for the full design and the accepted
-- fire-and-forget notification-delivery tradeoff.
ALTER TABLE "branch_inventory" ADD COLUMN     "low_stock_alert_active" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "low_stock_alerted_at" TIMESTAMP(3);
