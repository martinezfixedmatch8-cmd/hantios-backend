-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('draft', 'sent', 'confirmed', 'partially_received', 'received', 'paid', 'cancelled');

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "archived_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "supplier_id" TEXT NOT NULL,
    "supplier_name_snapshot" TEXT NOT NULL,
    "supplier_phone_snapshot" TEXT,
    "supplier_email_snapshot" TEXT,
    "po_number" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'draft',
    "currency_code" TEXT NOT NULL,
    "exchange_rate" DECIMAL(14,6),
    "total_expected_value" DECIMAL(14,2) NOT NULL,
    "cancel_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_name_snapshot" TEXT NOT NULL,
    "sku_snapshot" TEXT,
    "quantity_ordered" DECIMAL(14,2) NOT NULL,
    "unit_cost_snapshot" DECIMAL(14,2) NOT NULL,
    "line_total" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "po_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_business_id_status_idx" ON "suppliers"("business_id", "status");

-- CreateIndex
CREATE INDEX "suppliers_business_id_name_idx" ON "suppliers"("business_id", "name");

-- CreateIndex
CREATE INDEX "purchase_orders_business_id_status_idx" ON "purchase_orders"("business_id", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_business_id_idx" ON "purchase_orders"("business_id");

-- CreateIndex
CREATE INDEX "purchase_orders_supplier_id_idx" ON "purchase_orders"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_business_id_po_number_key" ON "purchase_orders"("business_id", "po_number");

-- CreateIndex
CREATE INDEX "purchase_order_items_business_id_idx" ON "purchase_order_items"("business_id");

-- CreateIndex
CREATE INDEX "purchase_order_items_purchase_order_id_idx" ON "purchase_order_items"("purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "po_counters_business_id_key" ON "po_counters"("business_id");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_counters" ADD CONSTRAINT "po_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Requirement #9 (Module 11): line-item validation -- quantityOrdered > 0,
-- unitCostSnapshot >= 0. Prisma's schema DSL has no native CHECK constraint
-- syntax, so these live only here, matching this repo's established
-- hand-added-CHECK-constraint convention.
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "chk_purchase_order_items_quantity_positive" CHECK ("quantity_ordered" > 0);
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "chk_purchase_order_items_unit_cost_nonneg" CHECK ("unit_cost_snapshot" >= 0);

-- Requirement #13: total_expected_value is always server-calculated and
-- must never be negative (matches every other financial-total CHECK
-- constraint in this schema, e.g. chk_sales_total_nonneg).
ALTER TABLE "purchase_orders" ADD CONSTRAINT "chk_purchase_orders_total_nonneg" CHECK ("total_expected_value" >= 0);

