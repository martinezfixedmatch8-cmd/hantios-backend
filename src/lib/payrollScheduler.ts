import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { generatePayrollForAllBusinesses } from "../services/payroll.service";

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

export function startPayrollScheduler(): ScheduledTask {
  if (task) return task;
  task = cron.schedule(
    "0 1 * * *",
    () => {
      generatePayrollForAllBusinesses().catch((err) => {
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
