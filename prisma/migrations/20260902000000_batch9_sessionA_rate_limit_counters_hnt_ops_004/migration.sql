-- HNT-OPS-004 (Batch 9 Session A): the shared rate-limit counter store,
-- replacing express-rate-limit's default per-process MemoryStore. Pure
-- additive -- a brand-new table, no existing data touched.

CREATE TABLE "rate_limit_counters" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "reset_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rate_limit_counters_key_key" ON "rate_limit_counters"("key");
CREATE INDEX "rate_limit_counters_reset_at_idx" ON "rate_limit_counters"("reset_at");
