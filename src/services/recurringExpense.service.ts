import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { paginate } from "../lib/pagination";
import { runScheduledJob } from "../lib/scheduledJob";
import { computeDuePeriods, advanceRollingPeriod } from "../lib/recurrencePeriod";
import { createExpenseInTransaction } from "./expense.service";
import { RecurrenceRunsQuery } from "../validation/expense.schema";

// HNT-OPS-003 (Batch 8) -- the Recurring Expense Worker. Two layers, per
// Phase 0's own reconciliation of this repo's established scheduler pattern
// (payrollScheduler.ts) against a genuine per-occurrence dedup need:
//   Layer 1 (this file's runRecurringExpenseSweep) -- a coarse sweep-tick
//     gate through the EXISTING scheduled_job_runs table via
//     src/lib/scheduledJob.ts, reused as-is. Only proves "the sweep itself
//     ran," nothing domain-specific.
//   Layer 2 (ensureRunRow/claimRun/completeRunSuccess/completeRunFailure
//     below) -- the real per-(recurrence, scheduled_period) dedup guard,
//     re-implemented against the new expense_recurrence_runs table since
//     scheduledJob.ts hardcodes "scheduled_job_runs" in its own raw SQL and
//     cannot be pointed elsewhere (an established, repeated limitation in
//     this repo -- table identifiers aren't Prisma.sql-parameterizable).
//
// Unlike debt_reminders' claimReminderSlot (which MUST split claim from
// complete because a real WhatsApp send happens in between, and that I/O
// can't be transactional), generating a recurring expense has no external
// I/O in its own critical path -- so the actual generation (create the
// expense + link expense_id + mark succeeded) IS one single atomic
// transaction, satisfying Database Safety Invariant #2 literally. The claim
// step (ensureRunRow/claimRun) still has to be its own, separate write
// outside that transaction, though -- it's the one piece of state that must
// SURVIVE a failed generation attempt so attempts/backoff/dead-letter
// tracking works at all (a transaction that rolls back on failure rolls back
// everything written inside it, including any claim taken inside the same
// transaction) -- this mirrors scheduledJob.ts's own
// ensureJobRow/claimJob-outside, work-in-a-try, complete-in-the-catch shape
// exactly, just re-implemented against a different table.

const JOB_TYPE = "recurring_expense_scheduler_tick";
const SWEEP_MAX_ATTEMPTS = 3;

function slotKey(date: Date): string {
  return date.toISOString().slice(0, 10); // e.g. "2026-08-31"
}

export async function runRecurringExpenseSweep(now: Date = new Date()): Promise<void> {
  const jobKey = `${JOB_TYPE}:${slotKey(now)}`;
  await runScheduledJob(jobKey, JOB_TYPE, SWEEP_MAX_ATTEMPTS, async () => {
    await processDueRecurrences(now);
  });
}

export async function processDueRecurrences(now: Date): Promise<void> {
  const recurrences = await prisma.expense_recurrence.findMany({
    where: { active: true },
    include: { businesses: true },
  });

  for (const recurrence of recurrences) {
    const periods = computeDuePeriods(recurrence, recurrence.businesses, now);
    for (const period of periods) {
      await generateOccurrence(recurrence.id, recurrence.business_id, period);
    }
  }
}

async function ensureRunRow(recurrenceId: string, businessId: string, scheduledPeriod: Date): Promise<void> {
  // Never throws on a collision -- ON CONFLICT DO NOTHING means a repeated
  // discovery pass for the same (recurrence, scheduled_period) (a second
  // process, a restart, a duplicate cron fire) is a safe no-op.
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO expense_recurrence_runs (id, business_id, recurrence_id, scheduled_period, status, attempts, updated_at)
    VALUES (${generateId()}, ${businessId}, ${recurrenceId}, ${scheduledPeriod}, 'pending', 0, now())
    ON CONFLICT (recurrence_id, scheduled_period) DO NOTHING
  `);
}

// Eligible rows: pending (never attempted) or retry_wait whose backoff has
// elapsed. succeeded and dead_letter are permanently excluded -- a
// dead-lettered occurrence needs a human, not an automatic retry (Database
// Safety Invariant #5 -- terminal states are always excluded from any
// re-processing query).
async function claimRun(recurrenceId: string, scheduledPeriod: Date): Promise<{ id: string } | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE expense_recurrence_runs
    SET status = 'running', attempts = attempts + 1, updated_at = now()
    WHERE recurrence_id = ${recurrenceId} AND scheduled_period = ${scheduledPeriod}
      AND ( status = 'pending'
         OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= now())) )
    RETURNING id
  `);
  return rows[0] ?? null;
}

// Exponential backoff, capped -- same formula as scheduledJob.ts's own
// computeBackoffMs (2, 4, 8min, then flat 15min).
function computeBackoffMs(attempts: number): number {
  return Math.min(2 ** (attempts - 1) * 2 * 60_000, 15 * 60_000);
}

// A plain code constant, not a stored max_attempts column (unlike
// scheduled_job_runs) -- expense_recurrence_runs has no such column, and
// nothing requires one: the value doesn't vary per row, so comparing
// `attempts` against a fixed constant here is equivalent and avoids an
// otherwise-unneeded schema change beyond what was already approved.
const MAX_ATTEMPTS = 3;

async function completeRunFailure(id: string, error: string): Promise<void> {
  const run = await prisma.expense_recurrence_runs.findUniqueOrThrow({ where: { id } });
  if (run.attempts >= MAX_ATTEMPTS) {
    await prisma.expense_recurrence_runs.update({
      where: { id },
      data: { status: "dead_letter", last_error: error },
    });
    return;
  }
  await prisma.expense_recurrence_runs.update({
    where: { id },
    data: {
      status: "retry_wait",
      last_error: error,
      next_attempt_at: new Date(Date.now() + computeBackoffMs(run.attempts)),
    },
  });
}

// The one atomic generation transaction (Database Safety Invariant #2):
// create the expense, link expense_id, and mark the run succeeded, all
// together -- a failure at any point rolls back the whole thing, including
// the recurrence's own next_run/last_run advance, so a retry starts clean.
export async function generateOccurrence(recurrenceId: string, businessId: string, scheduledPeriod: Date): Promise<void> {
  await ensureRunRow(recurrenceId, businessId, scheduledPeriod);
  const claimed = await claimRun(recurrenceId, scheduledPeriod);
  if (!claimed) return; // already succeeded, claimed by another process, dead-lettered, or not yet due for retry

  let generated: { expenseId: string; amount: Prisma.Decimal; branchId: string | null; categoryId: string } | undefined;
  try {
    generated = await prisma.$transaction(async (tx) => {
      const recurrence = await tx.expense_recurrence.findUniqueOrThrow({
        where: { id: recurrenceId },
        include: { expenses: true },
      });
      const business = await tx.businesses.findUniqueOrThrow({ where: { id: businessId } });
      if (!business.owner_id) {
        throw new Error("Business has no owner_id configured -- cannot resolve a system actor for automated generation");
      }
      const owner = await tx.users.findUniqueOrThrow({ where: { id: business.owner_id } });

      const template = recurrence.expenses;
      // Variable-amount schedules have no known number at generation time by
      // definition (auto_post + variable is rejected at creation, so this
      // path is only ever reached via auto_draft) -- a $0.00 placeholder
      // draft that a human fills in the real number for before approving.
      // Flagged as an inferred design decision, not explicitly specified.
      const amount =
        recurrence.amount_type === "fixed" && recurrence.configured_amount
          ? recurrence.configured_amount
          : new Prisma.Decimal(0);

      const created = await createExpenseInTransaction(tx, {
        businessId,
        branchId: template.branch_id,
        scope: template.scope,
        category: { id: template.category_id, name: template.category_name },
        amount,
        currencyCode: template.currency_code ?? "",
        currencySymbol: template.currency_symbol,
        taxAmount: template.tax_amount ?? undefined,
        taxRate: template.tax_rate ?? undefined,
        taxIncluded: template.tax_included ?? undefined,
        paymentMethodId: template.payment_method_id,
        expenseDate: scheduledPeriod,
        vendorId: template.vendor_id,
        vendorName: template.vendor_name,
        referenceNumber: template.reference_number,
        description: template.description,
        notes: template.notes,
        source: "recurring",
        createdBy: owner.id,
        workflowOverride: recurrence.execution_mode === "auto_draft" ? { status: "draft" } : undefined,
        actorUserName: "Recurring Expense Worker",
        actorUserRole: owner.role,
      });

      await tx.expense_recurrence_runs.update({
        where: { id: claimed.id },
        data: { status: "succeeded", expense_id: created.id },
      });

      // monthly/daily derive due periods fresh from calendar state every
      // sweep (computeDuePeriods never reads next_run back for these two) --
      // only last_run is informational for them. weekly/quarterly/yearly are
      // rolling: next_run IS the source of truth for the next occurrence,
      // advanced here using the same confirmed-clamping date-fns helpers.
      const isRolling = recurrence.frequency !== "monthly" && recurrence.frequency !== "daily";
      await tx.expense_recurrence.update({
        where: { id: recurrenceId },
        data: {
          last_run: scheduledPeriod,
          ...(isRolling ? { next_run: advanceRollingPeriod(recurrence.frequency, scheduledPeriod, recurrence.interval) } : {}),
        },
      });

      await writeAuditLog(tx, {
        businessId,
        userId: owner.id,
        userName: "Recurring Expense Worker",
        userRole: owner.role,
        action: "expense.recurring_generated",
        entityType: "expense",
        entityId: created.id,
        reason: `Auto-generated from recurrence ${recurrenceId} for period ${scheduledPeriod.toISOString().slice(0, 10)}`,
      });

      return { expenseId: created.id, amount, branchId: template.branch_id, categoryId: template.category_id };
    }, { timeout: 15000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await completeRunFailure(claimed.id, message);
    return;
  }

  // Matches Module 11 Session B's own established precedent: any direct
  // caller of createExpenseInTransaction (bypassing the outer createExpense,
  // the only place that otherwise publishes ExpenseCreated) re-publishes it
  // itself -- "a real expense row now exists, same as every other path that
  // creates one."
  domainEvents.publish("ExpenseCreated", {
    expenseId: generated.expenseId,
    businessId,
    branchId: generated.branchId,
    categoryId: generated.categoryId,
    amount: generated.amount.toString(),
  });
  domainEvents.publish("RecurringExpenseGenerated", {
    businessId,
    recurrenceId,
    expenseId: generated.expenseId,
    scheduledPeriod: scheduledPeriod.toISOString().slice(0, 10),
  });
}

// expenseId is the TEMPLATE expense's own id (matching updateRecurrence's
// own established route/resolution convention -- GET /expenses/:id/recurrence/*
// -- :id is always the template expense, never the recurrence row's own id,
// which the client never sees directly).
export async function listRecurrenceRuns(expenseId: string, query: RecurrenceRunsQuery, businessId: string) {
  await getOwned(prisma.expenses.findUnique({ where: { id: expenseId } }), businessId, "Expense");
  const recurrence = await getOwned(
    prisma.expense_recurrence.findUnique({ where: { template_expense_id: expenseId } }),
    businessId,
    "Expense recurrence schedule"
  );

  const [rows, total] = await Promise.all([
    prisma.expense_recurrence_runs.findMany({
      where: { recurrence_id: recurrence.id, business_id: businessId },
      orderBy: [{ scheduled_period: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.expense_recurrence_runs.count({ where: { recurrence_id: recurrence.id, business_id: businessId } }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}
