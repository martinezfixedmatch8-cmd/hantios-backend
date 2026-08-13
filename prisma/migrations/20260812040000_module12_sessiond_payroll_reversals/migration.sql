-- Module 12 Session D: the PAID Payroll Reversal Ledger. This is the
-- ONLY new schema Session D needs -- FIXED_PLUS_TIME/CONTRACT/CUSTOM reuse
-- payroll_records.calculation_breakdown (Session C), Automatic Commission
-- Reallocation reuses commission_adjustments (Session C) as-is, and
-- Self-Service Attendance reuses attendance_records (Session B) as-is.

-- CreateTable
CREATE TABLE "payroll_reversals" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "payroll_record_id" TEXT NOT NULL,
    "delta_amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_reversals_payroll_record_id_idx" ON "payroll_reversals"("payroll_record_id");

-- CreateIndex
CREATE INDEX "payroll_reversals_business_id_idx" ON "payroll_reversals"("business_id");

-- AddForeignKey
ALTER TABLE "payroll_reversals" ADD CONSTRAINT "payroll_reversals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_reversals" ADD CONSTRAINT "payroll_reversals_payroll_record_id_fkey" FOREIGN KEY ("payroll_record_id") REFERENCES "payroll_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_reversals" ADD CONSTRAINT "payroll_reversals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added CHECK constraint (Prisma's schema DSL has no native CHECK
-- syntax -- same recipe as every prior financial/quantity table).
ALTER TABLE "payroll_reversals" ADD CONSTRAINT "chk_payroll_reversals_delta_amount_nonzero" CHECK ("delta_amount" != 0);
