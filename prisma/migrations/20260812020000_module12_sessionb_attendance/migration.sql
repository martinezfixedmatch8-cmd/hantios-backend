-- Module 12 Session B: Attendance & Time Tracking. Adds attendance_records
-- (the confirmed per-day-hours-entry design) + attendance_adjustments (the
-- confirmed non-destructive correction ledger) + two Calculation Snapshot
-- columns on payroll_records (hours_calculated/hourly_rate, both NULL for
-- FIXED_MONTHLY and every other model).

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('recorded', 'approved');

-- AlterTable
ALTER TABLE "payroll_records" ADD COLUMN     "hourly_rate" DECIMAL(14,2),
ADD COLUMN     "hours_calculated" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "work_date" DATE NOT NULL,
    "hours_worked" DECIMAL(5,2) NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'recorded',
    "recorded_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_adjustments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "attendance_record_id" TEXT NOT NULL,
    "delta_hours" DECIMAL(5,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_records_business_id_employee_id_work_date_idx" ON "attendance_records"("business_id", "employee_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_records_business_id_status_idx" ON "attendance_records"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_business_id_employee_id_work_date_key" ON "attendance_records"("business_id", "employee_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_adjustments_attendance_record_id_idx" ON "attendance_adjustments"("attendance_record_id");

-- CreateIndex
CREATE INDEX "attendance_adjustments_business_id_idx" ON "attendance_adjustments"("business_id");

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_attendance_record_id_fkey" FOREIGN KEY ("attendance_record_id") REFERENCES "attendance_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added CHECK constraints (Prisma's schema DSL has no native CHECK
-- syntax -- same recipe as every other financial/quantity table in this
-- repo, e.g. chk_debt_transactions_amount_nonzero).
ALTER TABLE "attendance_records" ADD CONSTRAINT "chk_attendance_records_hours_worked_nonneg" CHECK ("hours_worked" >= 0);
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "chk_attendance_adjustments_delta_hours_nonzero" CHECK ("delta_hours" != 0);
ALTER TABLE "payroll_records" ADD CONSTRAINT "chk_payroll_records_hours_calculated_nonneg" CHECK ("hours_calculated" IS NULL OR "hours_calculated" >= 0);
ALTER TABLE "payroll_records" ADD CONSTRAINT "chk_payroll_records_hourly_rate_nonneg" CHECK ("hourly_rate" IS NULL OR "hourly_rate" >= 0);
