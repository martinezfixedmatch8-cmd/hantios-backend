import { Prisma } from "@prisma/client";
import type { Store, Options, IncrementResponse, ClientRateLimitInfo } from "express-rate-limit";
import { prisma } from "./prisma";
import { generateId } from "./ids";
import { runScheduledJob } from "./scheduledJob";
import { logRateLimitStoreError } from "./logger";

// HNT-OPS-004 (Batch 9 Session A) -- a shared, distributed Store for
// express-rate-limit@8.6.0, replacing the default per-process MemoryStore.
// Confirmed via Phase 0.5's own repository-history verification: this
// repo's every observed P2028/maxWait failure has been inside
// prisma.$transaction() (interactive-transaction/maxWait semantics that
// only apply to that call); zero failures have ever been observed on a
// standalone prisma.$queryRaw/$executeRaw statement, including this
// session's own scheduledJob.ts (ensureJobRow/claimJob) and
// recurringExpense.service.ts (ensureRunRow/claimRun) precedents, both
// stress-tested for real. increment() below deliberately never opens a
// $transaction() -- one atomic INSERT ... ON CONFLICT ... DO UPDATE ...
// RETURNING statement, matching that exact proven pattern.
//
// createPostgresRateLimitStore is called once per limiter (11 times, one
// per src/middleware/rateLimit.ts entry), each with its own `prefix` --
// but every call closes over the SAME imported `prisma` singleton
// (src/lib/prisma.ts, this repo's one and only PrismaClient/
// @prisma/adapter-neon connection), satisfying "a single shared instance/
// client reused across all limiters, not 10 [11] separate store
// connections" literally: there is only ever one underlying database
// connection pool in this process to import.
export function createPostgresRateLimitStore(prefix: string): Store {
  let windowMs = 0;

  function fullKey(key: string): string {
    return `${prefix}:${key}`;
  }

  return {
    init(options: Options): void {
      windowMs = options.windowMs;
    },

    async increment(key: string): Promise<IncrementResponse> {
      try {
        const rows = await prisma.$queryRaw<{ count: number; reset_at: Date }[]>(Prisma.sql`
          INSERT INTO rate_limit_counters (id, key, count, reset_at, created_at, updated_at)
          VALUES (${generateId()}, ${fullKey(key)}, 1, now() + (${windowMs}::text || ' milliseconds')::interval, now(), now())
          ON CONFLICT (key) DO UPDATE SET
            count = CASE WHEN rate_limit_counters.reset_at <= now() THEN 1 ELSE rate_limit_counters.count + 1 END,
            reset_at = CASE WHEN rate_limit_counters.reset_at <= now()
              THEN now() + (${windowMs}::text || ' milliseconds')::interval
              ELSE rate_limit_counters.reset_at END,
            updated_at = now()
          RETURNING count, reset_at
        `);
        const row = rows[0];
        if (!row) throw new Error("Failed to allocate a rate-limit counter row");
        return { totalHits: row.count, resetTime: row.reset_at };
      } catch (err) {
        logRateLimitStoreError("increment", err);
        throw err; // express-rate-limit's own passOnStoreError decides fail-open vs fail-closed from here
      }
    },

    async decrement(key: string): Promise<void> {
      try {
        await prisma.$executeRaw(Prisma.sql`
          UPDATE rate_limit_counters SET count = GREATEST(count - 1, 0), updated_at = now()
          WHERE key = ${fullKey(key)}
        `);
      } catch (err) {
        logRateLimitStoreError("decrement", err);
        throw err;
      }
    },

    async resetKey(key: string): Promise<void> {
      try {
        await prisma.$executeRaw(Prisma.sql`DELETE FROM rate_limit_counters WHERE key = ${fullKey(key)}`);
      } catch (err) {
        logRateLimitStoreError("resetKey", err);
        throw err;
      }
    },

    async get(key: string): Promise<ClientRateLimitInfo | undefined> {
      try {
        const rows = await prisma.$queryRaw<{ count: number; reset_at: Date }[]>(Prisma.sql`
          SELECT count, reset_at FROM rate_limit_counters WHERE key = ${fullKey(key)}
        `);
        const row = rows[0];
        return row ? { totalHits: row.count, resetTime: row.reset_at } : undefined;
      } catch (err) {
        logRateLimitStoreError("get", err);
        throw err;
      }
    },
  };
}

// Storage hygiene only -- rate-limit CORRECTNESS never depends on this
// running. An expired-but-not-yet-cleaned row is still handled correctly
// by increment()'s own CASE WHEN reset_at <= now() branch on its very next
// hit; this sweep purely bounds table growth for clients who never come
// back. The 1-day grace period is well beyond the longest configured
// window (60 minutes, inviteCreateLimiter/signupLimiter), so a row is
// never deleted while its own window could still be legitimately active.
export async function cleanupExpiredRateLimitCounters(): Promise<number> {
  const result = await prisma.$executeRaw`
    DELETE FROM rate_limit_counters WHERE reset_at < now() - interval '1 day'
  `;
  return result;
}

// Mirrors idempotencyCleanupScheduler.ts's exact shape -- a stateless daily
// sweep via the existing scheduledJob.ts claim/lease primitive, reused as-is
// (no second scheduling architecture).
const JOB_TYPE = "rate_limit_counter_cleanup";
const MAX_ATTEMPTS = 3;

export async function runRateLimitCleanupTick(now: Date = new Date()): Promise<void> {
  const jobKey = `${JOB_TYPE}:${now.toISOString().slice(0, 10)}`;
  await runScheduledJob(jobKey, JOB_TYPE, MAX_ATTEMPTS, async () => {
    await cleanupExpiredRateLimitCounters();
  });
}
