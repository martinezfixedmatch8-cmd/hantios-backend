-- Sale Refund, Partial Refund & Inventory Restoration
-- partially_refunded is a business/UI state only, never the source of
-- truth for remaining refundable quantity (sale_refund_items is that).
-- refund_restock reuses Void's exact per-line inventory-restoration
-- pattern, restocking only the resellable portion of a returned line.

-- AlterEnum
ALTER TYPE "AdjustmentType" ADD VALUE 'refund_restock';

-- AlterEnum
ALTER TYPE "SaleStatus" ADD VALUE 'partially_refunded';

-- CreateTable
CREATE TABLE "sale_refunds" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "reversal_sale_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_refund_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "sale_refund_id" TEXT NOT NULL,
    "line_index" INTEGER NOT NULL,
    "product_id" TEXT NOT NULL,
    "returned_quantity" DECIMAL(14,2) NOT NULL,
    "restockable_quantity" DECIMAL(14,2) NOT NULL,
    "write_off_quantity" DECIMAL(14,2) NOT NULL,
    "unit_cost_snapshot" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_refund_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sale_refunds_reversal_sale_id_key" ON "sale_refunds"("reversal_sale_id");

-- CreateIndex
CREATE INDEX "sale_refunds_business_id_idx" ON "sale_refunds"("business_id");

-- CreateIndex
CREATE INDEX "sale_refunds_sale_id_idx" ON "sale_refunds"("sale_id");

-- CreateIndex
CREATE INDEX "sale_refund_items_business_id_idx" ON "sale_refund_items"("business_id");

-- CreateIndex
CREATE INDEX "sale_refund_items_sale_refund_id_idx" ON "sale_refund_items"("sale_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_refund_items_sale_refund_id_line_index_key" ON "sale_refund_items"("sale_refund_id", "line_index");

-- AddForeignKey
ALTER TABLE "sale_refunds" ADD CONSTRAINT "sale_refunds_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_refunds" ADD CONSTRAINT "sale_refunds_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_refunds" ADD CONSTRAINT "sale_refunds_reversal_sale_id_fkey" FOREIGN KEY ("reversal_sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_refunds" ADD CONSTRAINT "sale_refunds_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_refund_items" ADD CONSTRAINT "sale_refund_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_refund_items" ADD CONSTRAINT "sale_refund_items_sale_refund_id_fkey" FOREIGN KEY ("sale_refund_id") REFERENCES "sale_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_refund_items" ADD CONSTRAINT "sale_refund_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added CHECK constraints -- Prisma's schema DSL has no native CHECK
-- syntax, same recipe as every other hand-added constraint in this repo.
ALTER TABLE "sale_refund_items" ADD CONSTRAINT "chk_sale_refund_items_returned_quantity_positive" CHECK (returned_quantity > 0);
ALTER TABLE "sale_refund_items" ADD CONSTRAINT "chk_sale_refund_items_restockable_quantity_range" CHECK (restockable_quantity >= 0 AND restockable_quantity <= returned_quantity);
-- Real, DB-enforced arithmetic guarantee (write_off = returned - restockable),
-- not just an app-layer computation -- mirrors chk_po_proforma_invoices_total_check's
-- own precedent for a derived-but-still-CHECK-verified column.
ALTER TABLE "sale_refund_items" ADD CONSTRAINT "chk_sale_refund_items_write_off_quantity_check" CHECK (write_off_quantity = returned_quantity - restockable_quantity);
ALTER TABLE "sale_refund_items" ADD CONSTRAINT "chk_sale_refund_items_unit_cost_nonneg" CHECK (unit_cost_snapshot >= 0);
