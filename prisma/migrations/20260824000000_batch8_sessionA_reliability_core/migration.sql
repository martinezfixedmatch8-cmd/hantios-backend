-- Batch 8 Session A (HNT-OPS-001, HNT-IDEMP-001/002, HNT-DELIV-001)
-- Hand-authored (not prisma migrate diff's raw output) to sequence a safe
-- NOT NULL column add against a table with live rows, matching the same
-- "add nullable -> backfill -> lock down" recipe already established for
-- Batch 2's email_verification_token_hash migration.

-- 1. New job/lease table (HNT-OPS-001), fully additive.
CREATE TYPE "ScheduledJobStatus" AS ENUM ('pending', 'running', 'retry_wait', 'succeeded', 'dead_letter');

CREATE TABLE "scheduled_job_runs" (
    "id" TEXT NOT NULL,
    "job_key" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "status" "ScheduledJobStatus" NOT NULL DEFAULT 'pending',
    "leased_until" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_job_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scheduled_job_runs_job_key_key" ON "scheduled_job_runs"("job_key");
CREATE INDEX "scheduled_job_runs_job_type_status_idx" ON "scheduled_job_runs"("job_type", "status");

-- 2. idempotency_keys: actor scoping (HNT-IDEMP-001) + payload-hash/TTL
-- (HNT-IDEMP-002). Added nullable first so the ADD COLUMN itself can never
-- fail against existing rows, backfilled, then locked to NOT NULL only for
-- actor_id (payload_hash/expires_at stay nullable by design -- see the
-- schema's own field comments for why).
ALTER TABLE "idempotency_keys" ADD COLUMN "actor_id" TEXT;
ALTER TABLE "idempotency_keys" ADD COLUMN "payload_hash" TEXT;
ALTER TABLE "idempotency_keys" ADD COLUMN "expires_at" TIMESTAMP(3);

-- Legacy rows: no real actor identity was ever recorded, and no payload
-- hash exists to protect them -- assign a sentinel actor_id and a short
-- (1 hour) expiry so they're swept away promptly by the new cleanup job
-- rather than lingering forever unprotected. A generous-enough window
-- that an in-flight retry from just before this migration still replays
-- correctly.
UPDATE "idempotency_keys"
SET "actor_id" = 'legacy',
    "expires_at" = CURRENT_TIMESTAMP + INTERVAL '1 hour'
WHERE "actor_id" IS NULL;

ALTER TABLE "idempotency_keys" ALTER COLUMN "actor_id" SET NOT NULL;

-- The old (business_id, key, endpoint) uniqueness is a plain unique INDEX
-- (confirmed live via pg_indexes before writing this, not assumed), not a
-- named CONSTRAINT -- matching Prisma's own @@unique generation. It is
-- strictly wider than the new one: since every existing row is backfilled
-- to the same constant actor_id ('legacy'), no existing row pair can
-- violate the new index that didn't already violate the old one
-- (impossible, since the old one was already enforced). Safe to swap.
--
-- CORRECTED ordering: CREATE the new index BEFORE DROPping the old one.
-- The reverse order (drop-then-create, as this file originally read)
-- leaves a real window, mid-migration, where NEITHER index exists and
-- (business_id, key, endpoint) uniqueness is briefly unenforced at the
-- database level -- a concurrent claim from a genuinely different actor
-- sharing an existing (business_id, key, endpoint) triple could momentarily
-- succeed uncaught in that gap. Creating first (both indexes coexist
-- briefly, which is fine -- the new one is a strict widening, never in
-- conflict with the old one) then dropping means uniqueness is continuously
-- enforced by at least one index at every instant of this migration.
CREATE UNIQUE INDEX "idempotency_keys_business_id_actor_id_key_endpoint_key" ON "idempotency_keys"("business_id", "actor_id", "key", "endpoint");
DROP INDEX "idempotency_keys_business_id_key_endpoint_key";

-- 3. ReceiptDeliveryStatus: sending/unknown (HNT-DELIV-001). Not used in
-- this same migration transaction, so a plain ADD VALUE is safe on modern
-- Postgres without a separate migration.
ALTER TYPE "ReceiptDeliveryStatus" ADD VALUE 'sending';
ALTER TYPE "ReceiptDeliveryStatus" ADD VALUE 'unknown';

-- 4. receipt_delivery_attempts.idempotency_key (HNT-DELIV-001 correction)
-- -- lets the recovery sweep find and atomically complete the exact
-- paired idempotency_keys row for a stuck "sending" attempt, instead of
-- only ever touching the attempt row in isolation.
ALTER TABLE "receipt_delivery_attempts" ADD COLUMN "idempotency_key" TEXT;
