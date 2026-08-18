-- Batch 4 remediation (HNT2-PO-002 + HNT2-PO-003): PO advance-payment
-- reversals + supplier-payment-instruction lifecycle. Every ADD COLUMN
-- below is either DEFAULT-backed or nullable, so every existing row stays
-- correct with zero backfill: po_advance_payments.version starts at 0 (no
-- reversal has ever happened against any existing row); supplier_payment_
-- instructions.status starts 'active' (nothing was ever archived/revoked
-- before this migration existed, so 'active' is simply true for every
-- live row). Neither existing table's own already-stored snapshot fields
-- are touched by this migration at all.

CREATE TYPE "SupplierPaymentInstructionStatus" AS ENUM ('active', 'archived', 'revoked');

-- po_advance_payments: pure metadata change-counter for reversal
-- optimistic-locking. Never touches amount/currency_code/any snapshot
-- field.
ALTER TABLE "po_advance_payments" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- Supporting composite unique, required by Postgres so the reversals
-- table's own composite FK below can reference (business_id, id)
-- together. Adds no new restriction -- id is already globally unique via
-- the primary key, so (business_id, id) is trivially unique too.
CREATE UNIQUE INDEX "po_advance_payments_business_id_id_key" ON "po_advance_payments"("business_id", "id");

-- po_advance_payment_reversals: new append-only reversal ledger. Multiple
-- rows per original payment are expected (partial reversals allowed) --
-- no uniqueness constraint on original_payment_id.
CREATE TABLE "po_advance_payment_reversals" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "original_payment_id" TEXT NOT NULL,
    "delta_amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_advance_payment_reversals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "po_advance_payment_reversals_business_id_original_payment_i_idx"
    ON "po_advance_payment_reversals"("business_id", "original_payment_id", "created_at");

ALTER TABLE "po_advance_payment_reversals" ADD CONSTRAINT "po_advance_payment_reversals_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- THE tenant-integrity fix: composite FK, not a plain single-column one --
-- database-enforces that this reversal's business_id can never differ
-- from the original payment's own business_id. A mismatched pair is
-- structurally unrepresentable; Postgres rejects the INSERT before
-- application code ever runs.
ALTER TABLE "po_advance_payment_reversals" ADD CONSTRAINT "po_advance_payment_reversals_business_id_original_payment__fkey"
    FOREIGN KEY ("business_id", "original_payment_id") REFERENCES "po_advance_payments"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "po_advance_payment_reversals" ADD CONSTRAINT "po_advance_payment_reversals_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added CHECK (migrate diff never generates these, same recipe as
-- every prior CHECK constraint in this repo's own migration history): a
-- reversal only ever reduces the balance, never increases it.
ALTER TABLE "po_advance_payment_reversals" ADD CONSTRAINT "chk_po_advance_payment_reversals_delta_amount_negative"
    CHECK ("delta_amount" < 0);

-- supplier_payment_instructions: lifecycle fields.
ALTER TABLE "supplier_payment_instructions" ADD COLUMN "status" "SupplierPaymentInstructionStatus" NOT NULL DEFAULT 'active';
ALTER TABLE "supplier_payment_instructions" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "supplier_payment_instructions" ADD COLUMN "expiry_date" DATE;
ALTER TABLE "supplier_payment_instructions" ADD COLUMN "archived_at" TIMESTAMP(3);
ALTER TABLE "supplier_payment_instructions" ADD COLUMN "archived_by" TEXT;
ALTER TABLE "supplier_payment_instructions" ADD COLUMN "revoked_at" TIMESTAMP(3);
ALTER TABLE "supplier_payment_instructions" ADD COLUMN "revoked_by" TEXT;

ALTER TABLE "supplier_payment_instructions" ADD CONSTRAINT "supplier_payment_instructions_archived_by_fkey"
    FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_payment_instructions" ADD CONSTRAINT "supplier_payment_instructions_revoked_by_fkey"
    FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
