-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('prepayment', 'net_30', 'net_60', 'net_90');

-- CreateEnum
CREATE TYPE "WalletNetwork" AS ENUM ('trc20', 'erc20');

-- CreateEnum
CREATE TYPE "ProformaInvoiceStatus" AS ENUM ('issued', 'superseded');

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "payment_terms" "PaymentTerms";

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "payment_terms" "PaymentTerms";

-- CreateTable
CREATE TABLE "supplier_payment_instructions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "beneficiary_name" TEXT NOT NULL,
    "bank_name" TEXT,
    "account_number" TEXT,
    "iban" TEXT,
    "swift" TEXT,
    "wallet_address" TEXT,
    "network" "WalletNetwork",
    "default_currency" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "supplier_payment_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proforma_invoice_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "proforma_invoice_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_proforma_invoices" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "agreement_snapshot_id" TEXT,
    "invoice_number" TEXT NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "shipping_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "insurance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "currency_code" TEXT NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" TEXT NOT NULL,
    "storage_key" TEXT,
    "status" "ProformaInvoiceStatus" NOT NULL DEFAULT 'issued',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_proforma_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_advance_payments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "proforma_invoice_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency_code" TEXT NOT NULL,
    "exchange_rate_snapshot" DECIMAL(14,6),
    "base_currency" TEXT,
    "supplier_currency" TEXT,
    "payment_method_id" TEXT,
    "supplier_payment_instruction_id" TEXT NOT NULL,
    "beneficiary_name_snapshot" TEXT NOT NULL,
    "bank_name_snapshot" TEXT,
    "account_number_snapshot" TEXT,
    "iban_snapshot" TEXT,
    "swift_snapshot" TEXT,
    "wallet_address_snapshot" TEXT,
    "network_snapshot" "WalletNetwork",
    "reference" TEXT,
    "installment_label" TEXT,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_advance_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_payment_instructions_business_id_idx" ON "supplier_payment_instructions"("business_id");

-- CreateIndex
CREATE INDEX "supplier_payment_instructions_supplier_id_idx" ON "supplier_payment_instructions"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "proforma_invoice_counters_business_id_key" ON "proforma_invoice_counters"("business_id");

-- CreateIndex
CREATE INDEX "po_proforma_invoices_purchase_order_id_idx" ON "po_proforma_invoices"("purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "po_proforma_invoices_business_id_invoice_number_key" ON "po_proforma_invoices"("business_id", "invoice_number");

-- CreateIndex
CREATE INDEX "po_advance_payments_purchase_order_id_idx" ON "po_advance_payments"("purchase_order_id");

-- CreateIndex
CREATE INDEX "po_advance_payments_proforma_invoice_id_idx" ON "po_advance_payments"("proforma_invoice_id");

-- AddForeignKey
ALTER TABLE "supplier_payment_instructions" ADD CONSTRAINT "supplier_payment_instructions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_instructions" ADD CONSTRAINT "supplier_payment_instructions_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_instructions" ADD CONSTRAINT "supplier_payment_instructions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proforma_invoice_counters" ADD CONSTRAINT "proforma_invoice_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_proforma_invoices" ADD CONSTRAINT "po_proforma_invoices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_proforma_invoices" ADD CONSTRAINT "po_proforma_invoices_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_proforma_invoices" ADD CONSTRAINT "po_proforma_invoices_agreement_snapshot_id_fkey" FOREIGN KEY ("agreement_snapshot_id") REFERENCES "po_negotiation_agreement_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_proforma_invoices" ADD CONSTRAINT "po_proforma_invoices_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_advance_payments" ADD CONSTRAINT "po_advance_payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_advance_payments" ADD CONSTRAINT "po_advance_payments_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_advance_payments" ADD CONSTRAINT "po_advance_payments_proforma_invoice_id_fkey" FOREIGN KEY ("proforma_invoice_id") REFERENCES "po_proforma_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_advance_payments" ADD CONSTRAINT "po_advance_payments_supplier_payment_instruction_id_fkey" FOREIGN KEY ("supplier_payment_instruction_id") REFERENCES "supplier_payment_instructions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_advance_payments" ADD CONSTRAINT "po_advance_payments_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_advance_payments" ADD CONSTRAINT "po_advance_payments_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added CHECK constraints + partial unique index -- Prisma's schema DSL
-- has no native CHECK-constraint or partial-unique-index syntax (same
-- documented gap as every prior table needing one in this repo:
-- chk_debt_transactions_*, chk_expense_attachments_size_range, Customer
-- Records' active-only phone uniqueness). Raw SQL is the only way to
-- express these.

-- Only one default payment instruction per supplier at a time -- a REAL
-- guard against a concurrent race (two requests both setting default:true
-- for the same supplier), not just an app-layer "unset the old one first"
-- convention.
CREATE UNIQUE INDEX "ux_supplier_payment_instructions_one_default" ON "supplier_payment_instructions" ("supplier_id") WHERE "is_default" = true;

-- A payment instruction with none of iban/account_number/wallet_address is
-- meaningless (nowhere to actually send money).
ALTER TABLE "supplier_payment_instructions" ADD CONSTRAINT "chk_supplier_payment_instructions_has_target" CHECK ("iban" IS NOT NULL OR "account_number" IS NOT NULL OR "wallet_address" IS NOT NULL);
-- network only makes sense alongside a wallet_address.
ALTER TABLE "supplier_payment_instructions" ADD CONSTRAINT "chk_supplier_payment_instructions_network_requires_wallet" CHECK ("network" IS NULL OR "wallet_address" IS NOT NULL);

-- total must equal the sum of its own parts -- a real DB-level guarantee,
-- not just an app-layer check, mirroring chk_sales_total_nonneg's own
-- "protect the arithmetic invariant in the database" precedent.
ALTER TABLE "po_proforma_invoices" ADD CONSTRAINT "chk_po_proforma_invoices_total_check" CHECK ("total" = "subtotal" + "shipping_cost" + "insurance");
ALTER TABLE "po_proforma_invoices" ADD CONSTRAINT "chk_po_proforma_invoices_amounts_nonneg" CHECK ("subtotal" >= 0 AND "shipping_cost" >= 0 AND "insurance" >= 0 AND "total" >= 0);

ALTER TABLE "po_advance_payments" ADD CONSTRAINT "chk_po_advance_payments_amount_positive" CHECK ("amount" > 0);

