import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { runScheduledJob } from "./scheduledJob";
import { cleanupExpiredIdempotencyKeys } from "./idempotency";

// Batch 8 Session A (HNT-IDEMP-002) -- a stateless sweep, same shape as
// receiptDeliveryRecovery.ts: every invocation deletes whatever is
// currently expired (and safe to remove -- response_status != 0, see
// idempotency.ts's own comment), regardless of how many prior daily
// cycles were missed. No catch-up window to enumerate.

const JOB_TYPE = "idempotency_key_cleanup";
const MAX_ATTEMPTS = 3;

let task: ScheduledTask | null = null;

export function startIdempotencyCleanupScheduler(): ScheduledTask {
  if (task) return task;
  task = cron.schedule(
    "0 2 * * *",
    () => {
      const jobKey = `${JOB_TYPE}:${new Date().toISOString().slice(0, 10)}`;
      runScheduledJob(jobKey, JOB_TYPE, MAX_ATTEMPTS, async () => {
        await cleanupExpiredIdempotencyKeys();
      }).catch((err) => {
        console.error("[idempotencyCleanupScheduler] tick failed:", err);
      });
    },
    { noOverlap: true, name: "idempotency-key-cleanup" }
  );
  return task;
}

export function stopIdempotencyCleanupScheduler(): void {
  task?.stop();
  task = null;
}
