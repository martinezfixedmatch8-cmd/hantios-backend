-- Tax Snapshot fields for expenses, added as a follow-up to Session 5A --
-- same "fields only, no calculation logic" pattern already applied to the
-- currency snapshot (currency_code/currency_symbol): manually entered per
-- expense, never derived from amount/rate or vice versa. A real Tax Engine
-- (auto-calculation, tax-code lookup) is a later phase's job.
ALTER TABLE "expenses" ADD COLUMN     "tax_amount" DECIMAL(14,2),
ADD COLUMN     "tax_included" BOOLEAN,
ADD COLUMN     "tax_rate" DECIMAL(5,2);

-- Defense-in-depth backing the app-layer guards, matching every other
-- financial-field CHECK constraint in this repo.
ALTER TABLE "expenses" ADD CONSTRAINT "chk_expenses_tax_amount_nonneg" CHECK (tax_amount IS NULL OR tax_amount >= 0);

ALTER TABLE "expenses" ADD CONSTRAINT "chk_expenses_tax_rate_range" CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100));
