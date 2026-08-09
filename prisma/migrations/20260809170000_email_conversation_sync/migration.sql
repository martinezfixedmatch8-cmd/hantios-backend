-- CreateEnum
CREATE TYPE "PoNegotiationMessageSource" AS ENUM ('portal', 'email', 'system');

-- CreateEnum
CREATE TYPE "UnmatchedInboundEmailReason" AS ENUM ('sender_not_recognized', 'thread_not_found', 'parse_error', 'signature_invalid');

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- AlterTable
ALTER TABLE "po_negotiation_messages" ADD COLUMN     "resend_email_id" TEXT,
ADD COLUMN     "source" "PoNegotiationMessageSource" NOT NULL DEFAULT 'portal';

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "negotiation_reply_token" TEXT;

-- CreateTable
CREATE TABLE "resend_inbound_claims" (
    "id" TEXT NOT NULL,
    "resend_email_id" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resend_inbound_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unmatched_inbound_emails" (
    "id" TEXT NOT NULL,
    "resend_email_id" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "subject" TEXT,
    "body_preview" TEXT,
    "reason" "UnmatchedInboundEmailReason" NOT NULL,
    "business_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unmatched_inbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "resend_inbound_claims_resend_email_id_key" ON "resend_inbound_claims"("resend_email_id");

-- CreateIndex
CREATE UNIQUE INDEX "unmatched_inbound_emails_resend_email_id_key" ON "unmatched_inbound_emails"("resend_email_id");

-- CreateIndex
CREATE INDEX "unmatched_inbound_emails_business_id_received_at_idx" ON "unmatched_inbound_emails"("business_id", "received_at");

-- CreateIndex
CREATE INDEX "unmatched_inbound_emails_reason_idx" ON "unmatched_inbound_emails"("reason");

-- CreateIndex
CREATE UNIQUE INDEX "po_negotiation_messages_resend_email_id_key" ON "po_negotiation_messages"("resend_email_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_negotiation_reply_token_key" ON "purchase_orders"("negotiation_reply_token");

-- AddForeignKey
ALTER TABLE "unmatched_inbound_emails" ADD CONSTRAINT "unmatched_inbound_emails_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

