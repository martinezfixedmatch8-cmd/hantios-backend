-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdjustmentType" ADD VALUE 'sale';
ALTER TYPE "AdjustmentType" ADD VALUE 'void';

-- CreateTable
CREATE TABLE "receipt_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receipt_counters_business_id_idx" ON "receipt_counters"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_counters_business_id_year_key" ON "receipt_counters"("business_id", "year");

-- AddForeignKey
ALTER TABLE "receipt_counters" ADD CONSTRAINT "receipt_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

