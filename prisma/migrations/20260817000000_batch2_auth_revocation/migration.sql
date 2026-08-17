-- Batch 2 remediation (Authentication, Revocation, Credential Lifecycle).
-- Hand-written, not a raw `prisma migrate diff` output: Prisma's own diff
-- generator produces DROP COLUMN + ADD COLUMN for both renames below, which
-- would silently destroy the 17 real users' live pending email-verification
-- tokens (confirmed via a live count immediately before writing this file).
-- staff_invites.token -> token_hash is a safe rename (confirmed 0 live
-- pending invites), done as a real RENAME COLUMN here too, for consistency
-- and because there is no reason to prefer DROP+ADD when a live rename is
-- available and just as cheap.
--
-- users.email_verification_token is handled in two steps across two
-- migrations, not one, specifically to protect those 17 live rows:
--   1. (this migration) ADD the new hashed column, leave the old plaintext
--      column in place untouched.
--   2. (see prisma/services, one-off script) a throwaway ts-node script
--      reads every user with a non-null email_verification_token, computes
--      hashToken(token) in JS (the exact same SHA-256 function this
--      migration's own application-code callers now use for lookups), and
--      writes it into email_verification_token_hash -- so already-sent
--      verification links keep working with zero user-facing disruption.
--   3. (see the sibling migration
--      20260817000100_drop_plaintext_email_verification_token) drops the
--      old plaintext column only after the backfill is confirmed complete.

-- HNT2-AUTH-001: real-time session/role/status revocation check.
ALTER TABLE "users" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;

-- HNT-AUTH-005 (extended scope): email_verification_token was plaintext,
-- the same bug class as staff_invites.token. New hashed column added
-- alongside the old one -- see the two-step plan above.
ALTER TABLE "users" ADD COLUMN "email_verification_token_hash" TEXT;
CREATE UNIQUE INDEX "users_email_verification_token_hash_key" ON "users"("email_verification_token_hash");

-- HNT-AUTH-005: staff_invites.token was plaintext (sessions.refresh_token_hash
-- already established the correct hashed-bearer-token precedent this
-- repo should have followed here from the start). A real RENAME, not
-- DROP+ADD -- confirmed 0 live pending invites at migration time (only 1
-- invite ever created, already accepted), but a rename is strictly safer
-- and no more work than a drop+add either way.
ALTER TABLE "staff_invites" RENAME COLUMN "token" TO "token_hash";
-- The unique index on the old column name is renamed along with it by
-- Postgres automatically when the column is renamed in place... actually
-- Postgres does NOT rename the index name automatically on a column
-- rename, only the index definition's column reference. Drop the
-- old-named index and recreate under the new expected name so
-- `staff_invites_token_hash_key` (Prisma's own naming convention, and what
-- migrate diff would generate for a matching schema) exists for real.
DROP INDEX "staff_invites_token_key";
CREATE UNIQUE INDEX "staff_invites_token_hash_key" ON "staff_invites"("token_hash");

-- HNT-AUTH-003: link-based password reset, a new dedicated table.
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX "password_reset_tokens_business_id_idx" ON "password_reset_tokens"("business_id");
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
