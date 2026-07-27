-- Fixes a real bug caught by the cross-business test suite: expense_number
-- was globally unique instead of unique per business. expense_counters
-- resets each business to its own 1-based sequence, so "EXP-000001"
-- legitimately recurs across different businesses -- a bare @unique on
-- expenses.expense_number made the second business's very first expense
-- collide with the first business's own "EXP-000001".
-- DropIndex
DROP INDEX "expenses_expense_number_key";

-- CreateIndex
CREATE UNIQUE INDEX "expenses_business_id_expense_number_key" ON "expenses"("business_id", "expense_number");
