-- CreateEnum
CREATE TYPE "InterestType" AS ENUM ('none', 'fixed', 'percentage');

-- CreateEnum
CREATE TYPE "ReminderType" AS ENUM ('before_due', 'overdue');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('sent', 'failed');

-- AlterEnum
ALTER TYPE "DebtStatus" ADD VALUE 'written_off';

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- AlterTable
ALTER TABLE "debts" DROP COLUMN "disputed",
DROP COLUMN "interest_rate",
DROP COLUMN "payment_history",
DROP COLUMN "reminder_sent_before",
DROP COLUMN "reminder_sent_overdue",
ADD COLUMN     "customer_id" TEXT NOT NULL,
ADD COLUMN     "interest_type" "InterestType" NOT NULL DEFAULT 'none',
ADD COLUMN     "interest_value" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "debt_payments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "debt_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "payment_method_id" TEXT,
    "payment_date" DATE NOT NULL,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "reversal_of_payment_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "debt_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debt_reminders" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "debt_id" TEXT NOT NULL,
    "reminder_type" "ReminderType" NOT NULL,
    "status" "ReminderStatus" NOT NULL,
    "provider" TEXT NOT NULL,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "next_retry" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debt_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "debt_payments_business_id_idx" ON "debt_payments"("business_id");

-- CreateIndex
CREATE INDEX "debt_payments_debt_id_idx" ON "debt_payments"("debt_id");

-- CreateIndex
CREATE INDEX "debt_reminders_business_id_idx" ON "debt_reminders"("business_id");

-- CreateIndex
CREATE INDEX "debt_reminders_debt_id_idx" ON "debt_reminders"("debt_id");

-- CreateIndex
CREATE INDEX "debts_customer_id_idx" ON "debts"("customer_id");

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_reversal_of_payment_id_fkey" FOREIGN KEY ("reversal_of_payment_id") REFERENCES "debt_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_reminders" ADD CONSTRAINT "debt_reminders_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_reminders" ADD CONSTRAINT "debt_reminders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint (Prisma's schema DSL has no native CHECK syntax -- same
-- pattern as every other CHECK constraint in this repo's migration history).
-- A payment row is either a real positive payment, or a reversal (negative
-- amount, reversal_of_payment_id set) -- mirrors chk_sales_total_nonneg's
-- shape exactly (sales.total >= 0 OR refund_of_sale_id IS NOT NULL).
ALTER TABLE "debt_payments" ADD CONSTRAINT "chk_debt_payments_amount_valid" CHECK (amount > 0 OR reversal_of_payment_id IS NOT NULL);

