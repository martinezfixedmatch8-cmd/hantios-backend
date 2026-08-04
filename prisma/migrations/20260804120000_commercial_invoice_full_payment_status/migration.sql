-- CreateEnum
CREATE TYPE "CommercialInvoiceStatus" AS ENUM ('issued', 'superseded');

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- CreateTable
CREATE TABLE "commercial_invoice_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "commercial_invoice_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_commercial_invoices" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "currency_code" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" TEXT NOT NULL,
    "storage_key" TEXT,
    "status" "CommercialInvoiceStatus" NOT NULL DEFAULT 'issued',
    "supersedes_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_commercial_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "commercial_invoice_counters_business_id_key" ON "commercial_invoice_counters"("business_id");

-- CreateIndex
CREATE INDEX "po_commercial_invoices_purchase_order_id_idx" ON "po_commercial_invoices"("purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "po_commercial_invoices_business_id_invoice_number_key" ON "po_commercial_invoices"("business_id", "invoice_number");

-- AddForeignKey
ALTER TABLE "commercial_invoice_counters" ADD CONSTRAINT "commercial_invoice_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_commercial_invoices" ADD CONSTRAINT "po_commercial_invoices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_commercial_invoices" ADD CONSTRAINT "po_commercial_invoices_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_commercial_invoices" ADD CONSTRAINT "po_commercial_invoices_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_commercial_invoices" ADD CONSTRAINT "po_commercial_invoices_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "po_commercial_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-added CHECK constraint -- same documented gap as every prior table
-- needing one in this repo (Prisma's schema DSL has no native CHECK syntax).
ALTER TABLE "po_commercial_invoices" ADD CONSTRAINT "chk_po_commercial_invoices_total_amount_nonneg" CHECK ("total_amount" >= 0);

