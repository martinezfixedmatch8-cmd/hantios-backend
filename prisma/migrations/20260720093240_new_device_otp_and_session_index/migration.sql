-- AlterEnum
ALTER TYPE "OtpPurpose" ADD VALUE 'new_device_login';

-- CreateIndex
CREATE INDEX "sessions_refresh_token_hash_idx" ON "sessions"("refresh_token_hash");

