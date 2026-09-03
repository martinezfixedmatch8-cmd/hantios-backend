import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { runRateLimitCleanupTick } from "./rateLimitStore";

// HNT-OPS-004 (Batch 9 Session A) -- mirrors idempotencyCleanupScheduler.ts's
// exact shape: a stateless daily sweep, no catch-up window to enumerate
// (every invocation deletes whatever is currently expired-by-more-than-a-
// day, regardless of how many prior cycles were missed). Rate-limit
// correctness never depends on this running -- see rateLimitStore.ts's own
// comment on cleanupExpiredRateLimitCounters.

let task: ScheduledTask | null = null;

export function startRateLimitCleanupScheduler(): ScheduledTask {
  if (task) return task;
  task = cron.schedule(
    "0 4 * * *",
    () => {
      runRateLimitCleanupTick().catch((err) => {
        console.error("[rateLimitCleanupScheduler] tick failed:", err);
      });
    },
    { noOverlap: true, name: "rate-limit-counter-cleanup" }
  );
  return task;
}

export function stopRateLimitCleanupScheduler(): void {
  task?.stop();
  task = null;
}
