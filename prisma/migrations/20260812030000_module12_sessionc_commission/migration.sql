-- Module 12 Session C: Sales Attribution & Commission Engine.
-- sales.salesperson_employee_id (current attribution, live) +
-- sale_attribution_events (append-only history) + commission_adjustments
-- (the confirmed manual, one-sided, post-generation correction primitive)
-- + payroll_records.calculation_breakdown (the confirmed general-purpose
-- snapshot for PERCENTAGE/FIXED_PLUS_PERCENTAGE onward) +
-- compensation_policies/compensation_policy_acknowledgements (the
-- confirmed backend-only policy/terms layer, reusing users.terms_
-- accepted_at's own versioned-acknowledgement shape).

-- CreateEnum
CREATE TYPE "SaleAttributionSource" AS ENUM ('creation', 'correction');

-- CreateEnum
CREATE TYPE "CompensationPolicyType" AS ENUM ('GENERAL', 'COMMISSION', 'ATTENDANCE', 'PIECE_RATE', 'CONTRACT');

-- CreateEnum
CREATE TYPE "CompensationPolicyStatus" AS ENUM ('active', 'superseded');

-- AlterTable
ALTER TABLE "payroll_records" ADD COLUMN     "calculation_breakdown" JSONB;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "salesperson_employee_id" TEXT;

-- CreateTable
CREATE TABLE "sale_attribution_events" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "previous_employee_id" TEXT,
    "new_employee_id" TEXT,
    "changed_by" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "source" "SaleAttributionSource" NOT NULL,

    CONSTRAINT "sale_attribution_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_adjustments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "payroll_record_id" TEXT NOT NULL,
    "sale_id" TEXT,
    "delta_amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_policies" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "policy_type" "CompensationPolicyType" NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "status" "CompensationPolicyStatus" NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compensation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_policy_acknowledgements" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" TEXT NOT NULL,

    CONSTRAINT "compensation_policy_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_attribution_events_business_id_sale_id_changed_at_idx" ON "sale_attribution_events"("business_id", "sale_id", "changed_at");

-- CreateIndex
CREATE INDEX "commission_adjustments_payroll_record_id_idx" ON "commission_adjustments"("payroll_record_id");

-- CreateIndex
CREATE INDEX "commission_adjustments_business_id_employee_id_idx" ON "commission_adjustments"("business_id", "employee_id");

-- CreateIndex
CREATE INDEX "compensation_policies_business_id_policy_type_status_idx" ON "compensation_policies"("business_id", "policy_type", "status");

-- CreateIndex
CREATE INDEX "compensation_policy_acknowledgements_business_id_policy_id_idx" ON "compensation_policy_acknowledgements"("business_id", "policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_policy_acknowledgements_employee_id_policy_id_key" ON "compensation_policy_acknowledgements"("employee_id", "policy_id");

-- CreateIndex
CREATE INDEX "sales_salesperson_employee_id_idx" ON "sales"("salesperson_employee_id");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_salesperson_employee_id_fkey" FOREIGN KEY ("salesperson_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_attribution_events" ADD CONSTRAINT "sale_attribution_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_attribution_events" ADD CONSTRAINT "sale_attribution_events_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_attribution_events" ADD CONSTRAINT "sale_attribution_events_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_payroll_record_id_fkey" FOREIGN KEY ("payroll_record_id") REFERENCES "payroll_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_policies" ADD CONSTRAINT "compensation_policies_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_policies" ADD CONSTRAINT "compensation_policies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_policy_acknowledgements" ADD CONSTRAINT "compensation_policy_acknowledgements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_policy_acknowledgements" ADD CONSTRAINT "compensation_policy_acknowledgements_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_policy_acknowledgements" ADD CONSTRAINT "compensation_policy_acknowledgements_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "compensation_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_policy_acknowledgements" ADD CONSTRAINT "compensation_policy_acknowledgements_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added CHECK constraints (Prisma's schema DSL has no native CHECK
-- syntax -- same recipe as every prior financial/quantity table).
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "chk_commission_adjustments_delta_amount_nonzero" CHECK ("delta_amount" != 0);
