-- CreateEnum
CREATE TYPE "PoSecureLinkStatus" AS ENUM ('active', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "PoNegotiationParty" AS ENUM ('owner', 'supplier', 'system');

-- CreateEnum
CREATE TYPE "PoNegotiationProposalStatus" AS ENUM ('draft', 'pending', 'accepted', 'rejected', 'superseded');

-- CreateEnum
CREATE TYPE "PoNegotiationFieldChanged" AS ENUM ('quantity', 'unit_price', 'delivery_date', 'shipping_method', 'product_substitution', 'product_added', 'product_removed');

-- CreateEnum
CREATE TYPE "PoNegotiationAttachmentType" AS ENUM ('image', 'pdf', 'excel', 'doc', 'video');

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "negotiation_respond_by" TIMESTAMP(3),
ADD COLUMN     "negotiation_round" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "po_secure_links" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "PoSecureLinkStatus" NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "last_viewed_at" TIMESTAMP(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "po_secure_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_negotiation_messages" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "sender_type" "PoNegotiationParty" NOT NULL,
    "sender_name" TEXT,
    "sender_department" TEXT,
    "sender_role" TEXT,
    "message_text" TEXT NOT NULL,
    "reply_to_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" TEXT,
    "read_at" TIMESTAMP(3),
    "read_by" "PoNegotiationParty",

    CONSTRAINT "po_negotiation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_negotiation_proposals" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "proposed_by" "PoNegotiationParty" NOT NULL,
    "proposer_name" TEXT,
    "proposer_department" TEXT,
    "proposer_role" TEXT,
    "comment" TEXT,
    "status" "PoNegotiationProposalStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 0,
    "revision_number" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "ip_address" TEXT,

    CONSTRAINT "po_negotiation_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_negotiation_proposal_changes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "field_changed" "PoNegotiationFieldChanged" NOT NULL,
    "item_id" TEXT,
    "old_value" TEXT NOT NULL,
    "new_value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_negotiation_proposal_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_negotiation_attachments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "message_id" TEXT,
    "proposal_id" TEXT,
    "type" "PoNegotiationAttachmentType" NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by" "PoNegotiationParty" NOT NULL,
    "uploaded_by_name" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_negotiation_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_negotiation_internal_notes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "note_text" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_negotiation_internal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_negotiation_agreement_snapshots" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "negotiation_round" INTEGER NOT NULL,
    "items_snapshot" JSONB NOT NULL,
    "shipping_method" TEXT,
    "delivery_date" TIMESTAMP(3),
    "total_expected_value" DECIMAL(14,2) NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_by" TEXT NOT NULL,

    CONSTRAINT "po_negotiation_agreement_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "po_secure_links_token_hash_key" ON "po_secure_links"("token_hash");

-- CreateIndex
CREATE INDEX "po_secure_links_business_id_idx" ON "po_secure_links"("business_id");

-- CreateIndex
CREATE INDEX "po_secure_links_purchase_order_id_idx" ON "po_secure_links"("purchase_order_id");

-- CreateIndex
CREATE INDEX "po_negotiation_messages_business_id_purchase_order_id_creat_idx" ON "po_negotiation_messages"("business_id", "purchase_order_id", "created_at");

-- CreateIndex
CREATE INDEX "po_negotiation_messages_reply_to_message_id_idx" ON "po_negotiation_messages"("reply_to_message_id");

-- CreateIndex
CREATE INDEX "po_negotiation_proposals_business_id_purchase_order_id_stat_idx" ON "po_negotiation_proposals"("business_id", "purchase_order_id", "status");

-- CreateIndex
CREATE INDEX "po_negotiation_proposal_changes_proposal_id_idx" ON "po_negotiation_proposal_changes"("proposal_id");

-- CreateIndex
CREATE INDEX "po_negotiation_proposal_changes_item_id_idx" ON "po_negotiation_proposal_changes"("item_id");

-- CreateIndex
CREATE INDEX "po_negotiation_attachments_purchase_order_id_idx" ON "po_negotiation_attachments"("purchase_order_id");

-- CreateIndex
CREATE INDEX "po_negotiation_attachments_message_id_idx" ON "po_negotiation_attachments"("message_id");

-- CreateIndex
CREATE INDEX "po_negotiation_attachments_proposal_id_idx" ON "po_negotiation_attachments"("proposal_id");

-- CreateIndex
CREATE INDEX "po_negotiation_internal_notes_purchase_order_id_idx" ON "po_negotiation_internal_notes"("purchase_order_id");

-- CreateIndex
CREATE INDEX "po_negotiation_agreement_snapshots_purchase_order_id_idx" ON "po_negotiation_agreement_snapshots"("purchase_order_id");

-- AddForeignKey
ALTER TABLE "po_secure_links" ADD CONSTRAINT "po_secure_links_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_secure_links" ADD CONSTRAINT "po_secure_links_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_secure_links" ADD CONSTRAINT "po_secure_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_secure_links" ADD CONSTRAINT "po_secure_links_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_messages" ADD CONSTRAINT "po_negotiation_messages_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_messages" ADD CONSTRAINT "po_negotiation_messages_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_messages" ADD CONSTRAINT "po_negotiation_messages_reply_to_message_id_fkey" FOREIGN KEY ("reply_to_message_id") REFERENCES "po_negotiation_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_proposals" ADD CONSTRAINT "po_negotiation_proposals_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_proposals" ADD CONSTRAINT "po_negotiation_proposals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_proposal_changes" ADD CONSTRAINT "po_negotiation_proposal_changes_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "po_negotiation_proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_proposal_changes" ADD CONSTRAINT "po_negotiation_proposal_changes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_proposal_changes" ADD CONSTRAINT "po_negotiation_proposal_changes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_attachments" ADD CONSTRAINT "po_negotiation_attachments_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_attachments" ADD CONSTRAINT "po_negotiation_attachments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_attachments" ADD CONSTRAINT "po_negotiation_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "po_negotiation_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_attachments" ADD CONSTRAINT "po_negotiation_attachments_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "po_negotiation_proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_internal_notes" ADD CONSTRAINT "po_negotiation_internal_notes_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_internal_notes" ADD CONSTRAINT "po_negotiation_internal_notes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_internal_notes" ADD CONSTRAINT "po_negotiation_internal_notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_agreement_snapshots" ADD CONSTRAINT "po_negotiation_agreement_snapshots_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_agreement_snapshots" ADD CONSTRAINT "po_negotiation_agreement_snapshots_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_agreement_snapshots" ADD CONSTRAINT "po_negotiation_agreement_snapshots_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "po_negotiation_proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_negotiation_agreement_snapshots" ADD CONSTRAINT "po_negotiation_agreement_snapshots_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateCheckConstraint
-- Same convention as every other financial/quantity field in this schema
-- (chk_inventory_adj_amount_positive, chk_expenses_amount_nonneg,
-- chk_debt_transactions_*, chk_expense_attachments_size_range). Added in
-- this same migration rather than a same-day follow-up, since these were
-- known upfront rather than a QA-caught gap.
ALTER TABLE "po_secure_links" ADD CONSTRAINT "chk_po_secure_links_view_count_nonneg" CHECK ("view_count" >= 0);
-- 10485760 bytes = 10 * 1024 * 1024, mirrors chk_expense_attachments_size_range exactly (same reused limit).
ALTER TABLE "po_negotiation_attachments" ADD CONSTRAINT "chk_po_negotiation_attachments_file_size_range" CHECK ("file_size_bytes" > 0 AND "file_size_bytes" <= 10485760);
ALTER TABLE "po_negotiation_agreement_snapshots" ADD CONSTRAINT "chk_po_negotiation_agreement_snapshots_total_nonneg" CHECK ("total_expected_value" >= 0);
ALTER TABLE "po_negotiation_agreement_snapshots" ADD CONSTRAINT "chk_po_negotiation_agreement_snapshots_round_nonneg" CHECK ("negotiation_round" >= 0);
ALTER TABLE "po_negotiation_proposals" ADD CONSTRAINT "chk_po_negotiation_proposals_revision_positive" CHECK ("revision_number" IS NULL OR "revision_number" > 0);


