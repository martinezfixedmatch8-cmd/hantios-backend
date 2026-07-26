-- Adds the CHECK constraints debt_transactions was missing since it was
-- introduced this session -- every other financial ledger table in this
-- repo has one (chk_debts_amount_nonneg, chk_sales_total_nonneg,
-- chk_inventory_adj_amount_positive, chk_expenses_amount_nonneg), and QA
-- flagged this table as the one exception, leaving the app-layer
-- interestAmount <= 0 early-return in applyInterest as the only thing
-- preventing a zero/invalid row.
--
-- `amount` is deliberately left as a signed column (per the original design:
-- this ledger is generically extensible to future transaction_type values
-- like payment_reversal, which -- mirroring debt_payments' own
-- reversal-is-a-negative-row convention -- would legitimately need a
-- negative amount). Only `interest_applied` is actually written this
-- session, and its amount is always positive by construction (the
-- interestAmount <= 0 case never reaches this table) -- so `!= 0` is the
-- correct constraint today: it rules out a meaningless zero-amount ledger
-- row without foreclosing a negative value for a not-yet-built transaction
-- type. Revisit if/when payment_reversal-style rows actually get migrated
-- into this table.
--
-- `balance_after` mirrors debts.amount_remaining, which already has its own
-- nonneg CHECK (chk_debts_amount_nonneg) -- safe to enforce unconditionally
-- regardless of which transaction_type produced it.
ALTER TABLE "debt_transactions" ADD CONSTRAINT "chk_debt_transactions_amount_nonzero" CHECK (amount != 0);

ALTER TABLE "debt_transactions" ADD CONSTRAINT "chk_debt_transactions_balance_after_nonneg" CHECK (balance_after >= 0);
