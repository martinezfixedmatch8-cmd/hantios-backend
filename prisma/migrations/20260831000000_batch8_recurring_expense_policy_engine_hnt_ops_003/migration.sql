-- HNT-OPS-003: Recurring Expense Worker/Policy Engine. Confirmed 0 live rows
-- in expense_recurrence on both DATABASE_URL and TEST_DATABASE_URL before
-- writing this file -- every NOT NULL column below is pure-additive, no
-- backfill required (same "confirmed empty table" precedent as the
-- Expense Session 5A reshape and the Customer Records reshape).

CREATE TYPE "ExpenseRecurrenceExecutionMode" AS ENUM ('auto_post', 'auto_draft');
CREATE TYPE "ExpenseRecurrenceAmountType" AS ENUM ('fixed', 'variable');

ALTER TABLE "expense_recurrence"
  ADD COLUMN "execution_mode" "ExpenseRecurrenceExecutionMode" NOT NULL,
  ADD COLUMN "amount_type" "ExpenseRecurrenceAmountType" NOT NULL,
  ADD COLUMN "configured_amount" DECIMAL(14,2),
  ADD COLUMN "start_date" DATE NOT NULL,
  ADD COLUMN "end_date" DATE,
  ADD COLUMN "daily_auto_post_confirmed" BOOLEAN NOT NULL DEFAULT false,
  -- Real accountability trail for the daily+auto_post override -- who
  -- confirmed it, and when. Populated together with the boolean itself,
  -- never independently (application-layer invariant, not DB-enforced --
  -- there is no CHECK requiring these two to be non-null together with the
  -- boolean, since a business could in principle flip the flag back to false
  -- later while the historical confirmation record stays, which is correct:
  -- it's a permanent record of "this was confirmed on this date," not a
  -- live mirror of the current flag state).
  ADD COLUMN "daily_auto_post_confirmed_by" TEXT,
  ADD COLUMN "daily_auto_post_confirmed_at" TIMESTAMP(3);

ALTER TABLE "expense_recurrence" ADD CONSTRAINT "expense_recurrence_daily_auto_post_confirmed_by_fkey"
  FOREIGN KEY ("daily_auto_post_confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Two CHECKs the FINAL document names explicitly --
ALTER TABLE "expense_recurrence" ADD CONSTRAINT "chk_expense_recurrence_no_variable_auto_post"
  CHECK (NOT (execution_mode = 'auto_post' AND amount_type = 'variable'));
ALTER TABLE "expense_recurrence" ADD CONSTRAINT "chk_expense_recurrence_daily_auto_post_confirmed"
  CHECK (NOT (frequency = 'daily' AND execution_mode = 'auto_post') OR daily_auto_post_confirmed = true);

-- Three additional CHECKs matching this repo's own established convention
-- (every financial/quantity column gets one -- chk_debts_amount_nonneg,
-- chk_sales_total_nonneg, chk_expenses_amount_nonneg, etc.), not explicitly
-- named by the document but the same class of guard as its own two:
ALTER TABLE "expense_recurrence" ADD CONSTRAINT "chk_expense_recurrence_configured_amount_matches_type"
  CHECK ((amount_type = 'fixed' AND configured_amount IS NOT NULL) OR (amount_type = 'variable' AND configured_amount IS NULL));
ALTER TABLE "expense_recurrence" ADD CONSTRAINT "chk_expense_recurrence_configured_amount_positive"
  CHECK (configured_amount IS NULL OR configured_amount > 0);
ALTER TABLE "expense_recurrence" ADD CONSTRAINT "chk_expense_recurrence_end_date_after_start"
  CHECK (end_date IS NULL OR end_date > start_date);

CREATE TABLE "expense_recurrence_runs" (
  "id" TEXT NOT NULL,
  "business_id" TEXT NOT NULL,
  "recurrence_id" TEXT NOT NULL,
  "scheduled_period" DATE NOT NULL,
  "status" "ScheduledJobStatus" NOT NULL DEFAULT 'pending',
  "expense_id" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "expense_recurrence_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "expense_recurrence_runs_recurrence_id_scheduled_period_key"
  ON "expense_recurrence_runs"("recurrence_id", "scheduled_period");
CREATE INDEX "expense_recurrence_runs_business_id_idx" ON "expense_recurrence_runs"("business_id");
CREATE INDEX "expense_recurrence_runs_status_idx" ON "expense_recurrence_runs"("status");

ALTER TABLE "expense_recurrence_runs" ADD CONSTRAINT "expense_recurrence_runs_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_recurrence_runs" ADD CONSTRAINT "expense_recurrence_runs_recurrence_id_fkey"
  FOREIGN KEY ("recurrence_id") REFERENCES "expense_recurrence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_recurrence_runs" ADD CONSTRAINT "expense_recurrence_runs_expense_id_fkey"
  FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Database Safety Invariant #1: succeeded requires expense_id, a real
-- single-row/single-table condition -- CHECK-enforceable directly, per
-- the document's own enforcement-layering guidance.
ALTER TABLE "expense_recurrence_runs" ADD CONSTRAINT "chk_expense_recurrence_runs_succeeded_requires_expense_id"
  CHECK (status != 'succeeded' OR expense_id IS NOT NULL);
