import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { prisma } from "./prisma";
import { getBusinessDay, dateOnlyString } from "./businessTime";
import { getDebtReminderSchedule } from "./businessSettings";
import { sendReminder } from "../services/debt.service";
import { runScheduledJob } from "./scheduledJob";

// Batch 8 Session A (HNT-OPS-001) -- job_type/max_attempts for this
// scheduler's own outer tick (the job/lease row tracks "did this hour's
// discovery pass run," never per-debt state -- sendReminder's own
// claim/complete against debt_reminders is untouched, still the one true
// per-debt dedup path).
const JOB_TYPE = "reminder_scheduler_tick";
const MAX_ATTEMPTS = 3;

// Bounded catch-up: on every tick (including one fired immediately at
// process boot), enumerate the current UTC hour-slot plus up to 6 prior
// ones that haven't yet succeeded. discoverAndSendReminders is fully
// idempotent and current-state-scanning (never "replay what was due at
// that specific historical hour"), so this isn't replaying history -- it's
// giving a downtime-recovering process a few fast, real chances to catch
// up promptly instead of silently waiting for its own next natural tick,
// each recorded as its own real job_key for observability. Deliberately
// NOT business-timezone-scoped: confirmed via direct review that
// discoverAndSendReminders' own outer iteration is timezone-agnostic by
// design (it scans every business, then resolves eligibility per-business
// via getBusinessDay INSIDE the loop) -- the same separation of concerns
// payrollScheduler.ts's own comment already documents for its own outer
// tick, re-verified here to hold for this scheduler too.
const CATCH_UP_HOURS = 6;

function hourSlotKey(date: Date): string {
  return date.toISOString().slice(0, 13); // e.g. "2026-08-24T14"
}

// Orchestration boundary: this module's ONLY job is "discover which debts
// are reminder-eligible right now, call the one true send path." Zero
// delivery logic, zero retry logic, zero WhatsApp-specific code lives here
// -- all of that already lives in debt.service.ts's sendReminder /
// getNotificationProvider. When real queue infrastructure (hardening
// roadmap Session 7+) replaces node-cron's tick loop, only this discovery
// trigger gets swapped out; sendReminder and everything downstream of it
// doesn't change at all.
export async function discoverAndSendReminders(): Promise<{ attempted: number; businessesChecked: number }> {
  const businesses = await prisma.businesses.findMany({
    select: { id: true, timezone: true, business_day_start_time: true, settings: true, owner_id: true },
  });

  let attempted = 0;

  for (const business of businesses) {
    const schedule = getDebtReminderSchedule(business.settings);
    if (!schedule.enabled) continue;
    // audit_logs.user_id is a required FK to a real users row -- a business
    // with no owner (shouldn't normally happen) has no FK-valid actor to
    // record automated sends under, so it's skipped rather than crashing the
    // whole tick for every other business.
    if (!business.owner_id) continue;
    const owner = await prisma.users.findUnique({ where: { id: business.owner_id } });
    if (!owner) continue;

    // System actor: a real, FK-valid user row (the owner's), with a
    // distinguishing userName so the audit trail is honest that this was
    // automated, not a manual owner action -- no schema change to the core,
    // cross-cutting audit_logs table for this feature.
    const systemActor = { userId: owner.id, businessId: business.id, userName: "Reminder Scheduler", userRole: owner.role };

    const today = getBusinessDay(business.timezone, business.business_day_start_time);
    const debts = await prisma.debts.findMany({
      where: { business_id: business.id, status: { in: ["open", "partially_paid"] } },
    });

    for (const debt of debts) {
      const due = dateOnlyString(debt.date_due);
      const isOverdue = today > due;
      const daysUntilDue = Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
      // overdueDays is a grace period, symmetric with beforeDueDays gating
      // the other side -- "send an overdue reminder this many days AFTER
      // date_due", not "the instant it becomes overdue." QA caught this
      // being silently unwired (isOverdue alone used to trigger eligibility
      // on day 1 overdue regardless of the configured value).
      const daysPastDue = isOverdue ? Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000) : 0;
      const eligible = (isOverdue && daysPastDue >= schedule.overdueDays) || (!isOverdue && daysUntilDue >= 0 && daysUntilDue <= schedule.beforeDueDays);
      if (!eligible) continue;

      attempted += 1;
      try {
        // sendReminder's own claim/complete mechanism makes a repeat call
        // for an already-handled (debt, type, business day) a safe no-op --
        // this loop doesn't need to know or care whether today is this
        // debt's first eligible tick or its fifth.
        await sendReminder(debt.id, systemActor);
      } catch (err) {
        // sendReminder already records genuine send failures in
        // debt_reminders itself; this catch is only for something going
        // wrong around that (e.g. a transient DB error) so one bad debt
        // doesn't abort the tick for every other business/debt.
        console.error(`[reminderScheduler] failed to process debt ${debt.id}:`, err);
      }
    }
  }

  return { attempted, businessesChecked: businesses.length };
}

let task: ScheduledTask | null = null;

// Batch 8 Session A (HNT-OPS-001) -- runs the current hour-slot plus up to
// CATCH_UP_HOURS prior ones (oldest first) that haven't yet succeeded,
// each through the durable job/lease claim (runScheduledJob), so a crash
// mid-tick leaves a real, reclaimable row instead of silently vanishing.
// Called both by the cron tick itself and once immediately at process
// boot (see startReminderScheduler below) -- the boot call is what closes
// a downtime gap promptly rather than waiting for the next natural `:00`.
export async function runReminderSchedulerCatchUp(now: Date = new Date()): Promise<void> {
  for (let hoursBack = CATCH_UP_HOURS; hoursBack >= 0; hoursBack--) {
    const slot = new Date(now.getTime() - hoursBack * 3_600_000);
    const jobKey = `${JOB_TYPE}:${hourSlotKey(slot)}`;
    await runScheduledJob(jobKey, JOB_TYPE, MAX_ATTEMPTS, async () => {
      await discoverAndSendReminders();
    });
  }
}

// Hourly -- frequent enough that a debt becoming reminder-eligible today
// doesn't wait almost a full day, cheap enough (a handful of queries per
// business) not to be wasteful. Business-day boundaries vary by each
// business's own timezone, so no single "run once at midnight" time would be
// correct for every business anyway -- hourly polling sidesteps that
// entirely. `noOverlap` is node-cron's own built-in defense (a slow tick
// can't start a second overlapping one) -- belt-and-suspenders alongside the
// real guarantee, which is now the durable job/lease claim above (HNT-OPS-001),
// not just an in-memory flag that does nothing to recover from a crash.
export function startReminderScheduler(): ScheduledTask {
  if (task) return task;
  task = cron.schedule(
    "0 * * * *",
    () => {
      runReminderSchedulerCatchUp().catch((err) => {
        console.error("[reminderScheduler] tick failed:", err);
      });
    },
    { noOverlap: true, name: "debt-reminder-scheduler" }
  );
  return task;
}

export function stopReminderScheduler(): void {
  task?.stop();
  task = null;
}
