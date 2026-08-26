import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { generateId } from "./ids";

// Batch 8 Session A (HNT-OPS-001) -- a durable job/lease primitive replacing
// node-cron's own in-memory-only noOverlap guard, which does nothing to
// recover a job that crashed mid-run (a single-instance deployment can
// still crash between claiming and completing a tick, leaving nothing to
// ever retry it). Shared by the reminder scheduler, payroll scheduler, and
// the new receipt-delivery-recovery/idempotency-cleanup sweeps -- each
// caller owns its own catch-up-window/slot-enumeration logic (genuinely
// job-specific), this file owns only the generic claim/complete mechanics.

const DEFAULT_LEASE_MS = 5 * 60_000; // 5 minutes -- generous for any of this session's own job bodies

// Ensures a pending row exists for this exact occurrence. Never throws on a
// collision -- ON CONFLICT DO NOTHING means a repeated discovery pass for
// the same job_key (a second process, a restart, a duplicate cron fire) is
// a safe no-op, not an error.
export async function ensureJobRow(jobKey: string, jobType: string, maxAttempts: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO scheduled_job_runs (id, job_key, job_type, status, max_attempts, attempts, updated_at)
    VALUES (${generateId()}, ${jobKey}, ${jobType}, 'pending', ${maxAttempts}, 0, now())
    ON CONFLICT (job_key) DO NOTHING
  `);
}

// The atomic claim. Eligible rows: pending (never attempted), retry_wait
// whose backoff has elapsed, or running whose lease has expired (a crashed
// job -- HNT-OPS-001's own critical correction: WHERE status='pending' AND
// (leased_until IS NULL OR leased_until < now()) would NEVER reclaim a job
// stuck in 'running' after a crash, since it stays outside the
// status='pending' branch forever). dead_letter and succeeded are
// permanently excluded -- a dead-lettered job needs a human, not an
// automatic retry loop.
export async function claimJob(jobKey: string, leaseMs: number = DEFAULT_LEASE_MS): Promise<{ id: string } | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE scheduled_job_runs
    SET status = 'running',
        leased_until = now() + (${leaseMs}::text || ' milliseconds')::interval,
        attempts = attempts + 1,
        updated_at = now()
    WHERE job_key = ${jobKey}
      AND ( status = 'pending'
         OR (status = 'retry_wait' AND next_attempt_at <= now())
         OR (status = 'running' AND leased_until < now()) )
    RETURNING id
  `);
  return rows[0] ?? null;
}

export async function completeJobSuccess(id: string): Promise<void> {
  await prisma.scheduled_job_runs.update({
    where: { id },
    data: { status: "succeeded", leased_until: null },
  });
}

// Exponential backoff, capped: 2, 4, 8min, then flat 15min -- retries stay
// within the job's own occurrence window (an hourly job's own next natural
// tick supersedes it regardless within the hour; this just gives it a few
// fast chances first).
function computeBackoffMs(attempts: number): number {
  return Math.min(2 ** (attempts - 1) * 2 * 60_000, 15 * 60_000);
}

export async function completeJobFailure(id: string, error: string): Promise<void> {
  const job = await prisma.scheduled_job_runs.findUniqueOrThrow({ where: { id } });
  if (job.attempts >= job.max_attempts) {
    await prisma.scheduled_job_runs.update({
      where: { id },
      data: { status: "dead_letter", last_error: error, leased_until: null },
    });
    return;
  }
  await prisma.scheduled_job_runs.update({
    where: { id },
    data: {
      status: "retry_wait",
      last_error: error,
      leased_until: null,
      next_attempt_at: new Date(Date.now() + computeBackoffMs(job.attempts)),
    },
  });
}

// The three-step orchestration every caller uses: ensure the row exists,
// attempt to claim it, and only if claimed, run the work. A claim miss
// (another process/tick already holds it, or it's dead-lettered) is a
// silent, correct no-op -- not an error.
export async function runScheduledJob(
  jobKey: string,
  jobType: string,
  maxAttempts: number,
  work: () => Promise<void>,
  leaseMs?: number
): Promise<void> {
  await ensureJobRow(jobKey, jobType, maxAttempts);
  const claimed = await claimJob(jobKey, leaseMs);
  if (!claimed) return;

  try {
    await work();
    await completeJobSuccess(claimed.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await completeJobFailure(claimed.id, message);
  }
}
