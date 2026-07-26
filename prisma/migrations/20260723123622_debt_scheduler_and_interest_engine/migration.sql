-- CreateEnum
CREATE TYPE "CalculationPolicy" AS ENUM ('one_time', 'daily', 'weekly', 'monthly');

-- CreateEnum
CREATE TYPE "InterestFormula" AS ENUM ('simple', 'compound');

-- CreateEnum
CREATE TYPE "PercentageBase" AS ENUM ('original_amount', 'remaining_balance');

-- CreateEnum
CREATE TYPE "DebtTransactionType" AS ENUM ('debt_created', 'interest_applied', 'interest_adjustment', 'payment', 'payment_reversal', 'discount', 'write_off', 'refund');

-- AlterEnum
ALTER TYPE "ReminderStatus" ADD VALUE 'pending';

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- AlterTable
ALTER TABLE "debt_reminders" ADD COLUMN     "business_date" DATE NOT NULL;

-- AlterTable
ALTER TABLE "debts" ADD COLUMN     "calculation_policy" "CalculationPolicy" NOT NULL DEFAULT 'one_time',
ADD COLUMN     "formula" "InterestFormula" NOT NULL DEFAULT 'simple',
ADD COLUMN     "last_interest_applied_at" TIMESTAMP(3),
ADD COLUMN     "percentage_base" "PercentageBase" NOT NULL DEFAULT 'remaining_balance';

-- CreateTable
CREATE TABLE "debt_transactions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "debt_id" TEXT NOT NULL,
    "transaction_type" "DebtTransactionType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "interest_type" "InterestType",
    "interest_formula" "InterestFormula",
    "percentage_base" "PercentageBase",
    "calculation_policy" "CalculationPolicy",
    "interest_rate_applied" DECIMAL(14,2),
    "periods_elapsed" INTEGER,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debt_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "debt_transactions_business_id_idx" ON "debt_transactions"("business_id");

-- CreateIndex
CREATE INDEX "debt_transactions_debt_id_idx" ON "debt_transactions"("debt_id");

-- CreateIndex
CREATE UNIQUE INDEX "debt_reminders_debt_id_reminder_type_business_date_key" ON "debt_reminders"("debt_id", "reminder_type", "business_date");

-- AddForeignKey
ALTER TABLE "debt_transactions" ADD CONSTRAINT "debt_transactions_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transactions" ADD CONSTRAINT "debt_transactions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transactions" ADD CONSTRAINT "debt_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

