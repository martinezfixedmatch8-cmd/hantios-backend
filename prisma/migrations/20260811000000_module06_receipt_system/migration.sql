-- CreateEnum
CREATE TYPE "ReceiptType" AS ENUM ('sale', 'refund', 'debt_payment', 'warehouse_stock_out', 'supplier_goods_received', 'po_settlement');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('issued', 'voided', 'refunded', 'partially_refunded');

-- CreateEnum
CREATE TYPE "ReceiptDeliveryChannel" AS ENUM ('whatsapp', 'pos_print');

-- CreateEnum
CREATE TYPE "ReceiptDeliveryStatus" AS ENUM ('pending', 'success', 'failed');

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "receipt_type" "ReceiptType" NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'issued',
    "sale_id" TEXT,
    "debt_payment_id" TEXT,
    "warehouse_movement_id" TEXT,
    "goods_received_note_id" TEXT,
    "purchase_order_payment_id" TEXT,
    "refund_of_receipt_id" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_timezone" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fee_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "language" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshot_version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_number_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "receipt_number_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_delivery_attempts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "channel" "ReceiptDeliveryChannel" NOT NULL,
    "status" "ReceiptDeliveryStatus" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "requested_by" TEXT NOT NULL,
    "customer_id" TEXT,
    "phone_snapshot" TEXT,
    "branch_id" TEXT,

    CONSTRAINT "receipt_delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receipts_business_id_receipt_type_idx" ON "receipts"("business_id", "receipt_type");

-- CreateIndex
CREATE INDEX "receipts_business_id_issued_at_idx" ON "receipts"("business_id", "issued_at");

-- CreateIndex
CREATE INDEX "receipts_business_id_status_idx" ON "receipts"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_business_id_receipt_number_key" ON "receipts"("business_id", "receipt_number");

-- CreateIndex
CREATE INDEX "receipt_number_counters_business_id_idx" ON "receipt_number_counters"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_number_counters_business_id_year_key" ON "receipt_number_counters"("business_id", "year");

-- CreateIndex
CREATE INDEX "receipt_delivery_attempts_business_id_idx" ON "receipt_delivery_attempts"("business_id");

-- CreateIndex
CREATE INDEX "receipt_delivery_attempts_receipt_id_idx" ON "receipt_delivery_attempts"("receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_delivery_attempts_receipt_id_attempt_number_key" ON "receipt_delivery_attempts"("receipt_id", "attempt_number");

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_debt_payment_id_fkey" FOREIGN KEY ("debt_payment_id") REFERENCES "debt_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_warehouse_movement_id_fkey" FOREIGN KEY ("warehouse_movement_id") REFERENCES "warehouse_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_goods_received_note_id_fkey" FOREIGN KEY ("goods_received_note_id") REFERENCES "goods_received_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_purchase_order_payment_id_fkey" FOREIGN KEY ("purchase_order_payment_id") REFERENCES "purchase_order_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_refund_of_receipt_id_fkey" FOREIGN KEY ("refund_of_receipt_id") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_number_counters" ADD CONSTRAINT "receipt_number_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_delivery_attempts" ADD CONSTRAINT "receipt_delivery_attempts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_delivery_attempts" ADD CONSTRAINT "receipt_delivery_attempts_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_delivery_attempts" ADD CONSTRAINT "receipt_delivery_attempts_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_delivery_attempts" ADD CONSTRAINT "receipt_delivery_attempts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_delivery_attempts" ADD CONSTRAINT "receipt_delivery_attempts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 🔒 CRITICAL SAFEGUARD -- hand-added, not expressible via Prisma's schema
-- DSL. Source-event uniqueness ("at most one receipt per source row") must
-- NOT be a plain multi-column @@unique across these sparse nullable FK
-- columns: Postgres treats NULL <> NULL even inside a composite unique
-- index, so two receipts rows sharing e.g. the same sale_id but both NULL
-- on every other source column would silently NOT collide under a naive
-- composite unique. Each source column instead gets its OWN partial unique
-- index, scoped to rows where that exact column is non-null -- this is a
-- real, DB-enforced guarantee, not an application-layer trust assumption.
--
-- One sale_id column safely covers BOTH the `sale` and `refund` receipt
-- types without a collision: a Refund Receipt's sale_id points at the
-- REVERSAL sales row (a distinct sales.id from the original Sale, created
-- fresh by refundSale), never the original -- so no single sales.id can
-- ever legitimately source two receipts.
-- ============================================================================

-- CreatePartialUniqueIndex
CREATE UNIQUE INDEX "ux_receipts_source_sale" ON "receipts"("business_id", "sale_id") WHERE "sale_id" IS NOT NULL;

-- CreatePartialUniqueIndex
CREATE UNIQUE INDEX "ux_receipts_source_debt_payment" ON "receipts"("business_id", "debt_payment_id") WHERE "debt_payment_id" IS NOT NULL;

-- CreatePartialUniqueIndex
CREATE UNIQUE INDEX "ux_receipts_source_warehouse_movement" ON "receipts"("business_id", "warehouse_movement_id") WHERE "warehouse_movement_id" IS NOT NULL;

-- CreatePartialUniqueIndex
CREATE UNIQUE INDEX "ux_receipts_source_grn" ON "receipts"("business_id", "goods_received_note_id") WHERE "goods_received_note_id" IS NOT NULL;

-- CreatePartialUniqueIndex
CREATE UNIQUE INDEX "ux_receipts_source_po_payment" ON "receipts"("business_id", "purchase_order_payment_id") WHERE "purchase_order_payment_id" IS NOT NULL;

-- CreateCheckConstraint
-- Defense-in-depth alongside the Zod/service-layer XOR validation --
-- exactly ONE of the five source FKs must be populated per row, matching
-- receipt_type. Mirrors this repo's existing supplier_payment_instructions
-- "at least one of iban/account_number/wallet_address" hand-added CHECK --
-- the same class of real-DB-guarantee-over-app-trust-alone guard.
ALTER TABLE "receipts" ADD CONSTRAINT "chk_receipts_exactly_one_source" CHECK (
  num_nonnulls("sale_id", "debt_payment_id", "warehouse_movement_id", "goods_received_note_id", "purchase_order_payment_id") = 1
);

-- CreateCheckConstraint
ALTER TABLE "receipts" ADD CONSTRAINT "chk_receipts_snapshot_version_positive" CHECK ("snapshot_version" > 0);

-- CreateCheckConstraint
ALTER TABLE "receipt_delivery_attempts" ADD CONSTRAINT "chk_receipt_delivery_attempts_attempt_number_positive" CHECK ("attempt_number" > 0);

