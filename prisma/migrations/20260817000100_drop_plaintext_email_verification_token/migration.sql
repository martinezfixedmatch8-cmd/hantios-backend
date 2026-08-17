-- Second step of the email_verification_token -> _hash migration (see
-- 20260817000000_batch2_auth_revocation's own comment for the full plan).
-- The one-off backfill script confirmed 0 users left without a hash before
-- this migration was written -- safe to drop the plaintext column now.
ALTER TABLE "users" DROP COLUMN "email_verification_token";
