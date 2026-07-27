-- Backs the app-layer size guard (max 10MB/file, request #6) with a real DB
-- CHECK, matching this repo's established pattern for every financial/
-- quantity table (chk_debts_amount_nonneg, chk_sales_total_nonneg,
-- chk_inventory_adj_amount_positive, chk_expenses_amount_nonneg,
-- chk_debt_transactions_*). 10485760 bytes = 10 * 1024 * 1024.
ALTER TABLE "expense_attachments" ADD CONSTRAINT "chk_expense_attachments_size_range" CHECK (size > 0 AND size <= 10485760);
