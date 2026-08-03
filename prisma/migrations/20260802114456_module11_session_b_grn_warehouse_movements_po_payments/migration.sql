-- CreateEnum
CREATE TYPE "PurchaseOrderPaymentStatus" AS ENUM ('unpaid', 'partially_paid', 'paid');

-- CreateEnum
CREATE TYPE "ThreeWayMatchStatus" AS ENUM ('matched', 'match_failed');

-- CreateEnum
CREATE TYPE "WarehouseMovementType" AS ENUM ('stock_in', 'stock_out');

-- CreateEnum
CREATE TYPE "WarehouseStockOutReason" AS ENUM ('branch_transfer', 'adjustment', 'damage', 'return', 'other');

-- AlterEnum
ALTER TYPE "ExpenseSource" ADD VALUE 'purchase_order';

-- AlterEnum
BEGIN;
CREATE TYPE "PurchaseOrderStatus_new" AS ENUM ('draft', 'sent', 'confirmed', 'partially_received', 'received', 'cancelled');
ALTER TABLE "public"."purchase_orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "purchase_orders" ALTER COLUMN "status" TYPE "PurchaseOrderStatus_new" USING ("status"::text::"PurchaseOrderStatus_new");
ALTER TYPE "PurchaseOrderStatus" RENAME TO "PurchaseOrderStatus_old";
ALTER TYPE "PurchaseOrderStatus_new" RENAME TO "PurchaseOrderStatus";
DROP TYPE "public"."PurchaseOrderStatus_old";
ALTER TABLE "purchase_orders" ALTER COLUMN "status" SET DEFAULT 'draft';
COMMIT;

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "grn_number" TEXT,
ADD COLUMN     "po_number" TEXT,
ADD COLUMN     "purchase_order_id" TEXT;

-- AlterTable
-- remaining_amount is added nullable first, then backfilled, then locked to
-- NOT NULL below -- the live purchase_orders table already has rows (this
-- session's own Session A test data), and a bare NOT NULL ADD COLUMN with no
-- default fails immediately against any existing row.
ALTER TABLE "purchase_orders" ADD COLUMN     "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "payment_status" "PurchaseOrderPaymentStatus" NOT NULL DEFAULT 'unpaid',
ADD COLUMN     "remaining_amount" DECIMAL(14,2);

-- Backfill: every pre-existing PO has paid_amount = 0 (the column didn't
-- exist until this migration), so remaining_amount = total_expected_value
-- exactly, matching this field's own "nothing owed until paid" rule.
UPDATE "purchase_orders" SET "remaining_amount" = "total_expected_value" WHERE "remaining_amount" IS NULL;

ALTER TABLE "purchase_orders" ALTER COLUMN "remaining_amount" SET NOT NULL;

-- AlterTable
ALTER TABLE "warehouse_stock" ADD COLUMN     "bin" TEXT,
ADD COLUMN     "rack" TEXT,
ADD COLUMN     "row_label" TEXT,
ADD COLUMN     "section" TEXT,
ADD COLUMN     "shelf" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "goods_received_notes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "grn_number" TEXT NOT NULL,
    "supplier_delivery_note" TEXT,
    "variance_notes" TEXT,
    "received_by" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_received_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_received_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "grn_id" TEXT NOT NULL,
    "po_item_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity_received" DECIMAL(14,2) NOT NULL,
    "unit_cost_actual" DECIMAL(14,2) NOT NULL,
    "variance_quantity" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_received_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grn_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "grn_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_payments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "invoice_amount" DECIMAL(14,2) NOT NULL,
    "invoice_reference" TEXT,
    "match_status" "ThreeWayMatchStatus" NOT NULL,
    "match_variance" DECIMAL(14,2) NOT NULL,
    "match_overridden" BOOLEAN NOT NULL DEFAULT false,
    "match_override_reason" TEXT,
    "expense_id" TEXT NOT NULL,
    "payment_date" DATE NOT NULL,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_movements" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "movement_number" TEXT NOT NULL,
    "movement_type" "WarehouseMovementType" NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" DECIMAL(14,2) NOT NULL,
    "quantity_before" DECIMAL(14,2) NOT NULL,
    "quantity_after" DECIMAL(14,2) NOT NULL,
    "grn_id" TEXT,
    "unit_cost" DECIMAL(14,2),
    "destination_branch_id" TEXT,
    "reason" "WarehouseStockOutReason",
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wsm_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wsm_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goods_received_notes_business_id_idx" ON "goods_received_notes"("business_id");

-- CreateIndex
CREATE INDEX "goods_received_notes_purchase_order_id_idx" ON "goods_received_notes"("purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_received_notes_business_id_grn_number_key" ON "goods_received_notes"("business_id", "grn_number");

-- CreateIndex
CREATE INDEX "goods_received_items_business_id_idx" ON "goods_received_items"("business_id");

-- CreateIndex
CREATE INDEX "goods_received_items_grn_id_idx" ON "goods_received_items"("grn_id");

-- CreateIndex
CREATE INDEX "goods_received_items_po_item_id_idx" ON "goods_received_items"("po_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "grn_counters_business_id_key" ON "grn_counters"("business_id");

-- CreateIndex
CREATE INDEX "purchase_order_payments_business_id_idx" ON "purchase_order_payments"("business_id");

-- CreateIndex
CREATE INDEX "purchase_order_payments_purchase_order_id_idx" ON "purchase_order_payments"("purchase_order_id");

-- CreateIndex
CREATE INDEX "warehouse_movements_business_id_movement_type_idx" ON "warehouse_movements"("business_id", "movement_type");

-- CreateIndex
CREATE INDEX "warehouse_movements_business_id_product_id_idx" ON "warehouse_movements"("business_id", "product_id");

-- CreateIndex
CREATE INDEX "warehouse_movements_warehouse_id_idx" ON "warehouse_movements"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_movements_business_id_movement_number_key" ON "warehouse_movements"("business_id", "movement_number");

-- CreateIndex
CREATE UNIQUE INDEX "wsm_counters_business_id_key" ON "wsm_counters"("business_id");

-- CreateIndex
CREATE INDEX "expenses_purchase_order_id_idx" ON "expenses"("purchase_order_id");

-- CreateIndex
CREATE INDEX "purchase_orders_business_id_payment_status_idx" ON "purchase_orders"("business_id", "payment_status");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_items" ADD CONSTRAINT "goods_received_items_grn_id_fkey" FOREIGN KEY ("grn_id") REFERENCES "goods_received_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_items" ADD CONSTRAINT "goods_received_items_po_item_id_fkey" FOREIGN KEY ("po_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_items" ADD CONSTRAINT "goods_received_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_items" ADD CONSTRAINT "goods_received_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_counters" ADD CONSTRAINT "grn_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_payments" ADD CONSTRAINT "purchase_order_payments_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_payments" ADD CONSTRAINT "purchase_order_payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_payments" ADD CONSTRAINT "purchase_order_payments_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_payments" ADD CONSTRAINT "purchase_order_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_grn_id_fkey" FOREIGN KEY ("grn_id") REFERENCES "goods_received_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_destination_branch_id_fkey" FOREIGN KEY ("destination_branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wsm_counters" ADD CONSTRAINT "wsm_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateCheckConstraint
-- quantity is always a positive movement amount regardless of direction
-- (movement_type discriminates stock_in vs stock_out) -- mirrors
-- inventory_adjustments' own chk_inventory_adj_amount_positive precedent.
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "chk_warehouse_movements_quantity_positive" CHECK ("quantity" > 0);

