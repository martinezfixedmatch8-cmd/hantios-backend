-- Expense Module core (Session 5A). Reshapes the `expenses` table, which
-- existed live but unused (zero rows, confirmed before writing this
-- migration; no service/controller ever wrote to it) -- a clean replacement,
-- not a data migration. Drops the dormant `attachments` JSON column and
-- `approved_by` (no approval workflow was asked for this session; that's a
-- separate, not-yet-built workflowStatus field for a later session, distinct
-- from this table's own archive/restore `status`) in favor of a real
-- relational expense_attachments table and a real created_by FK. Adds
-- expense_categories (seeded lazily per-business, not here) and
-- expense_counters (backs a flat per-business EXP-###### sequence -- see
-- src/lib/expenseNumber.ts for why this isn't a generalization of Sales'
-- per-business-per-year receipt_counters).
-- CreateEnum
CREATE TYPE "ExpenseCategoryType" AS ENUM ('system', 'custom');

-- CreateEnum
CREATE TYPE "ExpenseScope" AS ENUM ('business', 'branch');

-- CreateEnum
CREATE TYPE "ExpenseSource" AS ENUM ('manual', 'ocr', 'recurring', 'import', 'api');

-- DropForeignKey
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_approved_by_fkey";

-- DropIndex
DROP INDEX "expenses_business_id_category_idx";

-- DropIndex
DROP INDEX "expenses_business_id_date_idx";

-- AlterTable
ALTER TABLE "expenses" DROP COLUMN "approved_by",
DROP COLUMN "attachments",
DROP COLUMN "category",
DROP COLUMN "date",
ADD COLUMN     "category_id" TEXT NOT NULL,
ADD COLUMN     "category_name" TEXT NOT NULL,
ADD COLUMN     "created_by" TEXT NOT NULL,
ADD COLUMN     "currency_code" TEXT,
ADD COLUMN     "currency_symbol" TEXT,
ADD COLUMN     "expense_date" DATE NOT NULL,
ADD COLUMN     "expense_number" TEXT NOT NULL,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "payment_method_id" TEXT,
ADD COLUMN     "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "reference_number" TEXT,
ADD COLUMN     "scope" "ExpenseScope" NOT NULL,
ADD COLUMN     "source" "ExpenseSource" NOT NULL DEFAULT 'manual',
ADD COLUMN     "vendor_id" TEXT,
ADD COLUMN     "vendor_name" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ExpenseCategoryType" NOT NULL,
    "color" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "expense_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_attachments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_categories_business_id_idx" ON "expense_categories"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_business_id_name_key" ON "expense_categories"("business_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "expense_counters_business_id_key" ON "expense_counters"("business_id");

-- CreateIndex
CREATE INDEX "expense_attachments_expense_id_idx" ON "expense_attachments"("expense_id");

-- CreateIndex
CREATE INDEX "expense_attachments_business_id_idx" ON "expense_attachments"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_expense_number_key" ON "expenses"("expense_number");

-- CreateIndex
CREATE INDEX "expenses_business_id_category_id_idx" ON "expenses"("business_id", "category_id");

-- CreateIndex
CREATE INDEX "expenses_business_id_expense_date_idx" ON "expenses"("business_id", "expense_date");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_counters" ADD CONSTRAINT "expense_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_attachments" ADD CONSTRAINT "expense_attachments_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_attachments" ADD CONSTRAINT "expense_attachments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_attachments" ADD CONSTRAINT "expense_attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

