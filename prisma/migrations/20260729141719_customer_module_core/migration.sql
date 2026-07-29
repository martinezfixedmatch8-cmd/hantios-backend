-- DropIndex
DROP INDEX "customers_business_id_phone_key";

-- AlterTable
ALTER TABLE "customers" DROP COLUMN "phone",
ADD COLUMN     "archived_reason" TEXT,
ADD COLUMN     "customer_number" TEXT NOT NULL,
ADD COLUMN     "last_activity_at" TIMESTAMP(3),
ADD COLUMN     "last_debt_at" TIMESTAMP(3),
ADD COLUMN     "last_payment_at" TIMESTAMP(3),
ADD COLUMN     "last_purchase_at" TIMESTAMP(3),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "phone_normalized" TEXT NOT NULL,
ADD COLUMN     "phone_original" TEXT NOT NULL,
ADD COLUMN     "purchase_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "total_debts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "total_payments" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "customer_id" TEXT;

-- CreateTable
CREATE TABLE "customer_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "customer_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_counters_business_id_key" ON "customer_counters"("business_id");

-- CreateIndex
CREATE INDEX "customers_business_id_phone_normalized_idx" ON "customers"("business_id", "phone_normalized");

-- CreateIndex
CREATE INDEX "customers_business_id_name_idx" ON "customers"("business_id", "name");

-- CreateIndex
CREATE INDEX "customers_business_id_last_activity_at_idx" ON "customers"("business_id", "last_activity_at");

-- CreateIndex
CREATE INDEX "customers_business_id_debt_balance_idx" ON "customers"("business_id", "debt_balance");

-- CreateIndex
CREATE UNIQUE INDEX "customers_business_id_customer_number_key" ON "customers"("business_id", "customer_number");

-- CreateIndex
CREATE INDEX "sales_customer_id_idx" ON "sales"("customer_id");

-- AddForeignKey
ALTER TABLE "customer_counters" ADD CONSTRAINT "customer_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Requirement #1/#9 (Module 05): phone uniqueness per business applies only
-- among ACTIVE customers -- an archived customer must never block reuse of
-- their old phone number by a new (or restored) active customer. Prisma's
-- schema DSL has no partial/filtered unique index syntax, so this
-- constraint exists only here, in hand-added migration SQL, matching the
-- same convention already used for this schema's hand-added CHECK
-- constraints. This is the REAL guard against a concurrent duplicate-active-
-- phone race (create or restore) -- app-layer pre-checks are a courtesy on
-- top of it, not the guard itself.
CREATE UNIQUE INDEX "customers_business_id_phone_normalized_active_key"
  ON "customers" ("business_id", "phone_normalized")
  WHERE "status" = 'active';

