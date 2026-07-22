-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "business_day_end_time" TIME NOT NULL DEFAULT '23:59:59'::time,
ADD COLUMN     "business_day_start_time" TIME NOT NULL DEFAULT '00:00:00'::time;

-- AlterTable
ALTER TABLE "inventory_adjustments" ADD COLUMN     "sale_id" TEXT;

-- CreateIndex
CREATE INDEX "inventory_adjustments_sale_id_idx" ON "inventory_adjustments"("sale_id");

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

