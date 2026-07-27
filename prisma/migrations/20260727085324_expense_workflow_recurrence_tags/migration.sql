-- Session 5B: approval status workflow + recurring-expense architecture +
-- tags. Drops the 5A-era `recurring`/`recurrence_rule` fields (confirmed
-- zero live rows first) in favor of expense_recurrence's own existence being
-- the sole source of truth for "is this expense recurring" -- avoids
-- tracking one fact two ways, same principle that already dropped Debts'
-- redundant `disputed` boolean. `expense_recurrence` is architecture-only:
-- no scheduler exists yet to read `next_run`/`last_run` and actually
-- generate anything, same "ready but not automated" boundary the Debt
-- Reminder Scheduler used correctly before it was built. `tags`/
-- `expense_tags` is the first true many-to-many relation anywhere in this
-- schema (confirmed via full search before building it).
-- CreateEnum
CREATE TYPE "ExpenseWorkflowStatus" AS ENUM ('draft', 'pending', 'approved', 'rejected', 'paid');

-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('daily', 'weekly', 'monthly', 'quarterly', 'yearly');

-- AlterTable
ALTER TABLE "expenses" DROP COLUMN "recurrence_rule",
DROP COLUMN "recurring",
ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by" TEXT,
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "paid_by" TEXT,
ADD COLUMN     "rejected_at" TIMESTAMP(3),
ADD COLUMN     "rejected_by" TEXT,
ADD COLUMN     "workflow_status" "ExpenseWorkflowStatus" NOT NULL DEFAULT 'pending';

-- CreateTable
CREATE TABLE "expense_recurrence" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "template_expense_id" TEXT NOT NULL,
    "frequency" "RecurrenceFrequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "next_run" DATE,
    "last_run" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_recurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_tags" (
    "expense_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,

    CONSTRAINT "expense_tags_pkey" PRIMARY KEY ("expense_id","tag_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_recurrence_template_expense_id_key" ON "expense_recurrence"("template_expense_id");

-- CreateIndex
CREATE INDEX "expense_recurrence_business_id_idx" ON "expense_recurrence"("business_id");

-- CreateIndex
CREATE INDEX "tags_business_id_idx" ON "tags"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_business_id_name_key" ON "tags"("business_id", "name");

-- CreateIndex
CREATE INDEX "expense_tags_tag_id_idx" ON "expense_tags"("tag_id");

-- CreateIndex
CREATE INDEX "expenses_business_id_workflow_status_idx" ON "expenses"("business_id", "workflow_status");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_recurrence" ADD CONSTRAINT "expense_recurrence_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_recurrence" ADD CONSTRAINT "expense_recurrence_template_expense_id_fkey" FOREIGN KEY ("template_expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_tags" ADD CONSTRAINT "expense_tags_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_tags" ADD CONSTRAINT "expense_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
