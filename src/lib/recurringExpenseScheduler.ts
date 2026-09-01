import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { runRecurringExpenseSweep } from "../services/recurringExpense.service";

// HNT-OPS-003 (Batch 8) -- mirrors payrollScheduler.ts's exact shape. A
// single daily tick calls runRecurringExpenseSweep, which itself (via
// processDueRecurrences -> computeDuePeriods) enumerates every due-but-
// ungenerated period per recurrence, bounded by that frequency's own
// catch-up window and MAX_OCCURRENCES_PER_RECURRENCE_PER_SWEEP -- unlike
// payrollScheduler's own re-run-the-whole-sweep-N-times-for-N-calendar-days
// catch-up shape, the bound here lives inside the per-recurrence period
// calculation itself, not as an outer loop, since different frequencies need
// different-length windows.
let task: ScheduledTask | null = null;

export function startRecurringExpenseScheduler(): ScheduledTask {
  if (task) return task;
  task = cron.schedule(
    "0 3 * * *",
    () => {
      runRecurringExpenseSweep().catch((err) => {
        console.error("[recurringExpenseScheduler] tick failed:", err);
      });
    },
    { noOverlap: true, name: "recurring-expense-scheduler" }
  );
  return task;
}

export function stopRecurringExpenseScheduler(): void {
  task?.stop();
  task = null;
}
