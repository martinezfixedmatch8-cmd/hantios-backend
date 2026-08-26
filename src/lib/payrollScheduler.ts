import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { generatePayrollForAllBusinesses } from "../services/payroll.service";
import { runScheduledJob } from "./scheduledJob";

// Batch 8 Session A (HNT-OPS-001).
const JOB_TYPE = "payroll_scheduler_tick";
const MAX_ATTEMPTS = 3;

// Bounded catch-up: up to 3 missed daily slots, oldest first --
// generatePayrollForAllBusinesses is idempotent-by-construction (this
// file's own existing comment already explains why), so re-running it for
// a handful of recent days is harmless; a longer outage is treated as moot
// beyond this window since the very next real tick's own full scan
// supersedes it with zero functional loss.
const CATCH_UP_DAYS = 3;

function daySlotKey(date: Date): string {
  return date.toISOString().slice(0, 10); // e.g. "2026-08-24"
}

// Module 12 Session A -- primary monthly payroll generation, mirroring
// reminderScheduler.ts's own shape exactly. Idempotent by construction
// (generatePayrollForBusiness's own atomic INSERT ... ON CONFLICT DO
// NOTHING), so running this daily (rather than trying to fire exactly
// once on "the 1st" across every business's own timezone) is harmless --
// every tick after the first successful one for a given business+month
// simply finds nothing new to generate. Daily is frequent enough that a
// business created mid-month, or a missed tick, self-heals within a day;
// cheap enough (a handful of queries per business) not to be wasteful.
// The lazy/manual fallback (POST /payroll/generate) covers the same
// business day before this scheduler's own next tick.
let task: ScheduledTask | null = null;

// Batch 8 Session A (HNT-OPS-001) -- same durable job/lease claim as the
// reminder scheduler, daily slots instead of hourly. Called both by the
// cron tick and once immediately at process boot (see startPayrollScheduler).
export async function runPayrollSchedulerCatchUp(now: Date = new Date()): Promise<void> {
  for (let daysBack = CATCH_UP_DAYS; daysBack >= 0; daysBack--) {
    const slot = new Date(now.getTime() - daysBack * 86_400_000);
    const jobKey = `${JOB_TYPE}:${daySlotKey(slot)}`;
    await runScheduledJob(jobKey, JOB_TYPE, MAX_ATTEMPTS, async () => {
      await generatePayrollForAllBusinesses();
    });
  }
}

export function startPayrollScheduler(): ScheduledTask {
  if (task) return task;
  task = cron.schedule(
    "0 1 * * *",
    () => {
      runPayrollSchedulerCatchUp().catch((err) => {
        console.error("[payrollScheduler] tick failed:", err);
      });
    },
    { noOverlap: true, name: "payroll-generation-scheduler" }
  );
  return task;
}

export function stopPayrollScheduler(): void {
  task?.stop();
  task = null;
}
