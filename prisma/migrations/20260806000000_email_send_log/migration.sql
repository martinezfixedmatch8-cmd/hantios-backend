-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('SECURITY', 'BUSINESS_OPERATIONS', 'MARKETING', 'SYSTEM_ALERTS', 'TRANSACTIONAL');

-- CreateEnum
CREATE TYPE "SenderProfile" AS ENUM ('SECURITY', 'NOTIFICATIONS', 'BILLING', 'SUPPORT', 'SALES', 'MARKETING', 'CAREERS', 'HR', 'PARTNERS', 'LEGAL', 'PRIVACY', 'COMPLIANCE', 'NOREPLY');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('queued', 'sending', 'sent', 'failed', 'retrying');

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- CreateTable
CREATE TABLE "email_send_log" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "sender_profile" "SenderProfile" NOT NULL,
    "to_email" TEXT NOT NULL,
    "from_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'queued',
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_send_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_send_log_business_id_created_at_idx" ON "email_send_log"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "email_send_log_status_idx" ON "email_send_log"("status");

-- AddForeignKey
ALTER TABLE "email_send_log" ADD CONSTRAINT "email_send_log_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint (hand-added, Prisma's schema DSL has no native CHECK
-- syntax -- same recipe as every other CHECK constraint in this repo)
ALTER TABLE "email_send_log" ADD CONSTRAINT "chk_email_send_log_attempt_count_nonneg" CHECK ("attempt_count" >= 0);

