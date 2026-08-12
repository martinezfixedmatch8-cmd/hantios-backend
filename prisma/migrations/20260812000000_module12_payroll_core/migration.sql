-- CreateEnum
CREATE TYPE "CompensationModel" AS ENUM ('FIXED_MONTHLY', 'HOURLY', 'PERCENTAGE', 'FIXED_PLUS_PERCENTAGE', 'FIXED_PLUS_TIME', 'PIECE_RATE', 'CONTRACT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PayrollRecordStatus" AS ENUM ('pending', 'paid');

-- AlterEnum
ALTER TYPE "ReceiptType" ADD VALUE 'payroll';

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN     "payroll_record_id" TEXT;

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "department_id" TEXT,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "department_id" TEXT,
    "position_id" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "compensation_model" "CompensationModel" NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "currency_code" TEXT NOT NULL,
    "compensation_config" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_records" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "compensation_id" TEXT NOT NULL,
    "compensation_model" "CompensationModel" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency_code" TEXT NOT NULL,
    "status" "PayrollRecordStatus" NOT NULL DEFAULT 'pending',
    "payment_method_id" TEXT,
    "payment_reference" TEXT,
    "paid_at" TIMESTAMP(3),
    "paid_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payroll_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_business_id_idx" ON "departments"("business_id");

-- CreateIndex
CREATE INDEX "positions_business_id_idx" ON "positions"("business_id");

-- CreateIndex
CREATE INDEX "positions_department_id_idx" ON "positions"("department_id");

-- CreateIndex
CREATE INDEX "employees_business_id_status_idx" ON "employees"("business_id", "status");

-- CreateIndex
CREATE INDEX "employees_branch_id_idx" ON "employees"("branch_id");

-- CreateIndex
CREATE INDEX "employee_compensation_business_id_employee_id_effective_fro_idx" ON "employee_compensation"("business_id", "employee_id", "effective_from");

-- CreateIndex
CREATE INDEX "payroll_records_business_id_status_idx" ON "payroll_records"("business_id", "status");

-- CreateIndex
CREATE INDEX "payroll_records_business_id_period_year_period_month_idx" ON "payroll_records"("business_id", "period_year", "period_month");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_records_business_id_employee_id_period_year_period__key" ON "payroll_records"("business_id", "employee_id", "period_year", "period_month");

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payroll_record_id_fkey" FOREIGN KEY ("payroll_record_id") REFERENCES "payroll_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_compensation" ADD CONSTRAINT "employee_compensation_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_compensation" ADD CONSTRAINT "employee_compensation_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_compensation" ADD CONSTRAINT "employee_compensation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_compensation_id_fkey" FOREIGN KEY ("compensation_id") REFERENCES "employee_compensation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 🔒 Module 12 Session A -- extending Module 06's own CRITICAL SAFEGUARD to
-- the 7th source column. Same reasoning as the original 5: a plain
-- multi-column @@unique across sparse nullable columns would never catch a
-- duplicate (Postgres NULL <> NULL even inside a composite unique index),
-- so payroll_record_id gets its own dedicated partial unique index too.
-- ============================================================================

-- CreatePartialUniqueIndex
CREATE UNIQUE INDEX "ux_receipts_source_payroll" ON "receipts"("business_id", "payroll_record_id") WHERE "payroll_record_id" IS NOT NULL;

-- Postgres has no ALTER-CHECK -- drop and recreate chk_receipts_exactly_one_source
-- with the 7th column added to its num_nonnulls(...) list.
ALTER TABLE "receipts" DROP CONSTRAINT "chk_receipts_exactly_one_source";
ALTER TABLE "receipts" ADD CONSTRAINT "chk_receipts_exactly_one_source" CHECK (
  num_nonnulls("sale_id", "debt_payment_id", "warehouse_movement_id", "goods_received_note_id", "purchase_order_payment_id", "payroll_record_id") = 1
);

-- ============================================================================
-- Module 12 Session A -- new financial/domain CHECK constraints, same
-- recipe as every prior hand-added constraint in this repo's migration
-- history (Prisma's schema DSL has no native CHECK syntax).
-- ============================================================================

-- CreateCheckConstraint
ALTER TABLE "payroll_records" ADD CONSTRAINT "chk_payroll_records_amount_nonneg" CHECK ("amount" >= 0);

-- CreateCheckConstraint
ALTER TABLE "payroll_records" ADD CONSTRAINT "chk_payroll_records_period_month_range" CHECK ("period_month" >= 1 AND "period_month" <= 12);

-- CreateCheckConstraint
-- effective_to, when set, must genuinely be after effective_from -- a
-- zero-or-negative-length compensation period is never meaningful.
ALTER TABLE "employee_compensation" ADD CONSTRAINT "chk_employee_compensation_effective_range" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

