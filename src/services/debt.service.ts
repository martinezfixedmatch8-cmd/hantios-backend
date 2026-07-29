import { Prisma, type DebtStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { paginate } from "../lib/pagination";
import { badRequest, conflict, notFound } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { getBusinessDay, dateOnlyString } from "../lib/businessTime";
import { getDebtReminderSchedule, getDebtInterestPolicy } from "../lib/businessSettings";
import { getPeriodsElapsed, calculateInterest } from "../lib/interestEngine";
import { domainEvents } from "../lib/events";
import { getNotificationProvider } from "../notifications/registry";
import { findOrCreateCustomer } from "./customer.service";
import type {
  CreateDebtInput,
  ListDebtsQuery,
  RecordPaymentInput,
  ReversePaymentInput,
  DebtStatusActionInput,
  ApplyInterestInput,
} from "../validation/debt.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_DEBT_ENDPOINT = "POST /debts";
export const recordPaymentEndpoint = (debtId: string): string => `POST /debts/${debtId}/payments`;
export const reversePaymentEndpoint = (debtId: string, paymentId: string): string =>
  `POST /debts/${debtId}/payments/${paymentId}/reverse`;
export const writeOffEndpoint = (debtId: string): string => `POST /debts/${debtId}/write-off`;
export const applyInterestEndpoint = (debtId: string): string => `POST /debts/${debtId}/apply-interest`;

const DEBT_TRANSACTION_OPTIONS = { timeout: 15000 };

type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

// `today` is a business-day-resolved date string (getBusinessDay), computed
// once per request and passed in here rather than re-resolved per debt --
// the comparison itself (today > due) is exactly what businessTime.ts's own
// isOverdue() does internally; kept inline here since this function already
// needs the day-count for bucketing, not just the boolean.
function computeAging(dueDate: Date, today: string): { isOverdue: boolean; daysPastDue: number; agingBucket: AgingBucket } {
  const due = dateOnlyString(dueDate);
  const daysPastDue = Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000);
  if (daysPastDue <= 0) return { isOverdue: false, daysPastDue: 0, agingBucket: "current" };
  const agingBucket: AgingBucket = daysPastDue <= 30 ? "1-30" : daysPastDue <= 60 ? "31-60" : daysPastDue <= 90 ? "61-90" : "90+";
  return { isOverdue: true, daysPastDue, agingBucket };
}

// Shared by every response that includes a single debt -- never stored,
// always derived from Business.timezone + businessDayStartTime at read time
// (Requirement #8/#9). reminderRecommended is a simple, honest signal (not
// yet-due-but-within-schedule, or already overdue at all) -- the schedule's
// overdueDays field is exposed for the future scheduler's own cadence
// decisions, not consumed by this computed flag.
async function decorateDebt<T extends { date_due: Date; customer_id: string }>(debt: T, business: { timezone: string; business_day_start_time: Date; settings: Prisma.JsonValue }) {
  const today = getBusinessDay(business.timezone, business.business_day_start_time);
  const aging = computeAging(debt.date_due, today);
  const schedule = getDebtReminderSchedule(business.settings);
  const daysUntilDue = Math.round((Date.parse(dateOnlyString(debt.date_due)) - Date.parse(today)) / 86_400_000);
  return {
    ...debt,
    isOverdue: aging.isOverdue,
    daysPastDue: aging.isOverdue ? aging.daysPastDue : 0,
    agingBucket: aging.agingBucket,
    reminderSchedule: schedule,
    reminderRecommended: aging.isOverdue || (daysUntilDue >= 0 && daysUntilDue <= schedule.beforeDueDays),
  };
}

// Preserves a dispute hold: a routine payment/reversal doesn't silently clear
// `disputed` -- only the explicit resolve-dispute action does. Otherwise
// derived purely from the amounts, matching Requirement #9 (OVERDUE is never
// stored; the same principle applies to keeping status a pure function of
// amount_remaining rather than tracked as separate mutable state).
function recomputeStatus(currentStatus: DebtStatus, amountRemaining: Prisma.Decimal, amountOriginal: Prisma.Decimal): DebtStatus {
  if (currentStatus === "disputed") return "disputed";
  if (amountRemaining.lessThanOrEqualTo(0)) return "paid";
  if (amountRemaining.lessThan(amountOriginal)) return "partially_paid";
  return "open";
}

export async function createDebt(input: CreateDebtInput, actor: Actor, idempotencyKey: string) {
  if (input.branchId) {
    const branch = await getOwned(prisma.branches.findUnique({ where: { id: input.branchId } }), actor.businessId, "Branch");
    if (branch.status !== "active") throw badRequest("Branch is archived");
  }
  if (input.saleId) {
    await getOwned(prisma.sales.findUnique({ where: { id: input.saleId } }), actor.businessId, "Sale");
  }

  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  const amountOriginal = new Prisma.Decimal(input.amountOriginal);
  // Policy snapshot (scheduler/interest-engine extension): read the
  // business's CURRENT interest policy and copy it onto the new debt --
  // never a live lookup at calculation time. Exactly the same pattern Sales
  // already uses for costPriceAtSale. A later settings change only affects
  // debts created after the change.
  const interestPolicy = getDebtInterestPolicy(business.settings);

  const debt = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_DEBT_ENDPOINT);

    // Module 05: real find-or-create, shared with Sales -- an archived
    // customer holding this phone is never reused/reactivated (active-only
    // lookup), a brand-new active customer is created instead.
    const customer = await findOrCreateCustomer(tx, {
      businessId: actor.businessId,
      phoneRaw: input.customerPhone,
      name: input.customerName,
      defaultCountry: business.country,
    });

    const created = await tx.debts.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        branch_id: input.branchId,
        customer_id: customer.id,
        customer_phone: input.customerPhone,
        customer_name: input.customerName,
        customer_location: input.customerLocation,
        sale_id: input.saleId,
        amount_original: amountOriginal,
        amount_paid: 0,
        amount_remaining: amountOriginal,
        date_taken: input.dateTaken,
        date_due: input.dateDue,
        interest_enabled: interestPolicy.enabled,
        interest_type: interestPolicy.type,
        interest_value: interestPolicy.enabled ? new Prisma.Decimal(interestPolicy.value) : null,
        calculation_policy: interestPolicy.calculationPolicy,
        formula: interestPolicy.formula,
        percentage_base: interestPolicy.percentageBase,
        notes: input.notes,
        status: "open",
      },
    });

    // customers.debt_balance is a derived cache only (never authoritative --
    // debts/debt_payments are the source of truth), kept in sync here purely
    // for cheap reads elsewhere (CRM dashboards, customer lists, search).
    // total_debts/last_debt_at/last_activity_at use the just-created row's
    // own created_at, not a fresh new Date(), so the cache is byte-identical
    // to what the Timeline query will show for this same event.
    await tx.customers.updateMany({
      where: { id: customer.id },
      data: {
        debt_balance: { increment: amountOriginal },
        total_debts: { increment: 1 },
        last_debt_at: created.created_at,
        last_activity_at: created.created_at,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "debt.created",
      entityType: "debt",
      entityId: created.id,
      reason: `Debt of ${amountOriginal.toString()} recorded for ${input.customerName ?? input.customerPhone}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: await decorateDebt(created, business) })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_DEBT_ENDPOINT, 201, responseBody);

    return created;
  }, DEBT_TRANSACTION_OPTIONS);

  domainEvents.publish("DebtCreated", {
    debtId: debt.id,
    businessId: actor.businessId,
    customerId: debt.customer_id,
    amountOriginal: amountOriginal.toString(),
  });

  return decorateDebt(debt, business);
}

export async function listDebts(query: ListDebtsQuery, businessId: string) {
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
  const today = getBusinessDay(business.timezone, business.business_day_start_time);

  const conditions: Prisma.Sql[] = [Prisma.sql`business_id = ${businessId}`];
  if (query.status) conditions.push(Prisma.sql`status = ${query.status}::"DebtStatus"`);
  if (query.branchId) conditions.push(Prisma.sql`branch_id = ${query.branchId}`);
  if (query.search) {
    const like = `%${query.search}%`;
    conditions.push(Prisma.sql`(customer_name ILIKE ${like} OR customer_phone ILIKE ${like})`);
  }
  const whereClause = Prisma.join(conditions, " AND ");

  // Aging bucket is derived at query time via SQL CASE, never stored
  // (Requirement #8). "today" itself is resolved once in JS via the same
  // getBusinessDay helper every other business-day calculation in this repo
  // uses, then passed in as a plain date parameter -- avoids a second,
  // parallel reimplementation of business-day math written in raw SQL that
  // could drift from the JS version.
  const bucketedCte = Prisma.sql`
    SELECT *,
      (CASE
        WHEN ${today}::date <= date_due THEN 'current'
        WHEN (${today}::date - date_due) BETWEEN 1 AND 30 THEN '1-30'
        WHEN (${today}::date - date_due) BETWEEN 31 AND 60 THEN '31-60'
        WHEN (${today}::date - date_due) BETWEEN 61 AND 90 THEN '61-90'
        ELSE '90+'
      END) AS aging_bucket,
      (${today}::date > date_due) AS is_overdue,
      GREATEST(${today}::date - date_due, 0) AS days_past_due
    FROM debts
    WHERE ${whereClause}
  `;

  const outerConditions: Prisma.Sql[] = [];
  if (query.agingBucket) outerConditions.push(Prisma.sql`aging_bucket = ${query.agingBucket}`);
  if (query.isOverdue !== undefined) outerConditions.push(Prisma.sql`is_overdue = ${query.isOverdue}`);
  const outerWhere = outerConditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(outerConditions, " AND ")}` : Prisma.empty;

  const sortableFields = ["date_due", "amount_remaining", "created_at"];
  const sortColumn = sortableFields.includes(query.sort ?? "") ? (query.sort as string) : "date_due";
  const sortDir = query.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const skip = (query.page - 1) * query.pageSize;

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    WITH bucketed AS (${bucketedCte})
    SELECT * FROM bucketed
    ${outerWhere}
    ORDER BY ${Prisma.raw(sortColumn)} ${sortDir}
    LIMIT ${query.pageSize} OFFSET ${skip}
  `);

  const countRows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    WITH bucketed AS (${bucketedCte})
    SELECT COUNT(*)::bigint AS count FROM bucketed
    ${outerWhere}
  `);
  const total = Number(countRows[0]?.count ?? 0);

  const schedule = getDebtReminderSchedule(business.settings);
  // The raw-SQL CTE's computed columns come back snake_case (aging_bucket/
  // is_overdue/days_past_due) like every other DB column -- renamed here to
  // match decorateDebt()'s camelCase shape (agingBucket/isOverdue/
  // daysPastDue) so a client reads the same keys regardless of whether a
  // debt came from this list endpoint or POST/GET-single. QA caught this
  // divergence: it had shipped as two different key conventions for the
  // exact same computed fields.
  const data = rows.map(({ aging_bucket, is_overdue, days_past_due, ...row }) => ({
    ...row,
    agingBucket: aging_bucket,
    isOverdue: is_overdue,
    daysPastDue: days_past_due,
    reminderSchedule: schedule,
  }));

  return paginate(data, total, query.page, query.pageSize);
}

export async function getDebt(id: string, businessId: string) {
  const debt = await getOwned(prisma.debts.findUnique({ where: { id } }), businessId, "Debt");
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
  return decorateDebt(debt, business);
}

export async function recordPayment(debtId: string, input: RecordPaymentInput, actor: Actor, idempotencyKey: string) {
  const debt = await getOwned(prisma.debts.findUnique({ where: { id: debtId } }), actor.businessId, "Debt");
  if (debt.status === "paid" || debt.status === "written_off") {
    throw badRequest(`Cannot record a payment on a debt that is already ${debt.status}`);
  }
  if (input.paymentMethodId) {
    const pm = await getOwned(
      prisma.payment_methods.findUnique({ where: { id: input.paymentMethodId } }),
      actor.businessId,
      "Payment method"
    );
    if (pm.status !== "active") throw badRequest("Payment method is archived");
  }

  const amount = new Prisma.Decimal(input.amount);
  if (amount.greaterThan(debt.amount_remaining)) {
    throw badRequest("Payment amount cannot exceed the remaining balance");
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, recordPaymentEndpoint(debtId));

    const newRemaining = debt.amount_remaining.minus(amount);
    const newPaid = debt.amount_paid.plus(amount);
    const newStatus = recomputeStatus(debt.status, newRemaining, debt.amount_original);

    // Atomic guarded update: a stale version (a concurrent payment already
    // landed) fails this cleanly rather than allowing two payments to both
    // read the same starting balance and jointly overpay it.
    const updateResult = await tx.debts.updateMany({
      where: { id: debtId, business_id: actor.businessId, version: debt.version },
      data: { amount_remaining: newRemaining, amount_paid: newPaid, status: newStatus, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Debt was modified concurrently, please retry with the latest version");
    }

    const payment = await tx.debt_payments.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        debt_id: debtId,
        amount,
        payment_method_id: input.paymentMethodId,
        payment_date: input.paymentDate ?? new Date(),
        notes: input.notes,
        created_by: actor.userId,
      },
    });

    // A genuine new payment -- total_payments increments here only, never on
    // a reversal (see reversePayment below), matching purchase_count's own
    // "only a real new occurrence counts" rule.
    await tx.customers.updateMany({
      where: { id: debt.customer_id },
      data: {
        debt_balance: { decrement: amount },
        total_payments: { increment: 1 },
        last_payment_at: payment.created_at,
        last_activity_at: payment.created_at,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "debt.payment_added",
      entityType: "debt_payment",
      entityId: payment.id,
      reason: `Payment of ${amount.toString()} recorded for debt ${debtId}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: payment })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, recordPaymentEndpoint(debtId), 201, responseBody);

    return { payment, newRemaining };
  }, DEBT_TRANSACTION_OPTIONS);

  domainEvents.publish("DebtPaymentReceived", {
    debtId,
    businessId: actor.businessId,
    paymentId: result.payment.id,
    amount: amount.toString(),
    amountRemaining: result.newRemaining.toString(),
  });

  return result.payment;
}

export async function reversePayment(
  debtId: string,
  paymentId: string,
  input: ReversePaymentInput,
  actor: Actor,
  idempotencyKey: string
) {
  const debt = await getOwned(prisma.debts.findUnique({ where: { id: debtId } }), actor.businessId, "Debt");
  const payment = await getOwned(prisma.debt_payments.findUnique({ where: { id: paymentId } }), actor.businessId, "Payment");
  if (payment.debt_id !== debtId) {
    throw notFound("Payment not found");
  }
  if (payment.reversal_of_payment_id) {
    throw badRequest("Cannot reverse a reversal entry");
  }
  if (!payment.amount.greaterThan(0)) {
    throw badRequest("Cannot reverse a non-positive payment entry");
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, reversePaymentEndpoint(debtId, paymentId));

    // Atomic claim on the original payment row -- a stale version means it
    // was already reversed (or otherwise modified) concurrently. The
    // reversal itself is a NEW row (never an in-place edit or a delete),
    // mirroring exactly how Session 3B modeled Refund as a new, negated Sale.
    const claimResult = await tx.debt_payments.updateMany({
      where: { id: paymentId, business_id: actor.businessId, version: input.version },
      data: { version: { increment: 1 } },
    });
    if (claimResult.count === 0) {
      throw conflict("Payment was already reversed or modified concurrently");
    }

    const reversal = await tx.debt_payments.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        debt_id: debtId,
        amount: payment.amount.negated(),
        payment_method_id: payment.payment_method_id,
        payment_date: new Date(),
        notes: input.reason,
        created_by: actor.userId,
        reversal_of_payment_id: paymentId,
      },
    });

    const newRemaining = debt.amount_remaining.plus(payment.amount);
    const newPaid = debt.amount_paid.minus(payment.amount);
    const newStatus = recomputeStatus(debt.status, newRemaining, debt.amount_original);

    const debtUpdateResult = await tx.debts.updateMany({
      where: { id: debtId, business_id: actor.businessId, version: debt.version },
      data: { amount_remaining: newRemaining, amount_paid: newPaid, status: newStatus, version: { increment: 1 } },
    });
    if (debtUpdateResult.count === 0) {
      throw conflict("Debt was modified concurrently, please retry with the latest version");
    }

    // total_payments/last_payment_at deliberately untouched -- a reversal
    // corrects an existing payment rather than being a new one (mirrors how
    // voidSale never touches purchase_count either). last_activity_at still
    // moves forward: a real event happened, even though it's a correction.
    await tx.customers.updateMany({
      where: { id: debt.customer_id },
      data: { debt_balance: { increment: payment.amount }, last_activity_at: reversal.created_at },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "debt.payment_reversed",
      entityType: "debt_payment",
      entityId: reversal.id,
      reason: input.reason,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: reversal })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, reversePaymentEndpoint(debtId, paymentId), 201, responseBody);

    return { reversal, newRemaining };
  }, DEBT_TRANSACTION_OPTIONS);

  domainEvents.publish("DebtPaymentReceived", {
    debtId,
    businessId: actor.businessId,
    paymentId: result.reversal.id,
    amount: result.reversal.amount.toString(),
    amountRemaining: result.newRemaining.toString(),
  });

  return result.reversal;
}

async function transitionDebtStatus(
  debtId: string,
  actor: Actor,
  idempotencyKey: string,
  endpoint: string,
  guard: { where: (currentStatus: DebtStatus) => boolean; errorMessage: (currentStatus: DebtStatus) => string },
  targetStatus: DebtStatus | ((debt: { amount_remaining: Prisma.Decimal; amount_original: Prisma.Decimal }) => DebtStatus),
  auditAction: string,
  reason: string
) {
  const debt = await getOwned(prisma.debts.findUnique({ where: { id: debtId } }), actor.businessId, "Debt");
  if (!guard.where(debt.status)) {
    throw badRequest(guard.errorMessage(debt.status));
  }

  const resolvedTarget = typeof targetStatus === "function" ? targetStatus(debt) : targetStatus;

  const updated = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, endpoint);

    const result = await tx.debts.updateMany({
      where: { id: debtId, business_id: actor.businessId, version: debt.version },
      data: { status: resolvedTarget, version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw conflict("Debt was modified concurrently, please retry with the latest version");
    }

    // Write-off removes the amount from the customer's active outstanding
    // balance (it's no longer being pursued) -- amount_remaining itself is
    // left untouched (informational: what was actually written off stays
    // visible/traceable, never deleted or zeroed, per this module's own
    // "financial history, never physically deleted" principle).
    if (resolvedTarget === "written_off") {
      await tx.customers.updateMany({
        where: { id: debt.customer_id },
        data: { debt_balance: { decrement: debt.amount_remaining }, last_activity_at: new Date() },
      });
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: auditAction,
      entityType: "debt",
      entityId: debtId,
      reason,
    });

    const updatedDebt = await tx.debts.findUniqueOrThrow({ where: { id: debtId } });
    const responseBody = JSON.parse(JSON.stringify({ data: updatedDebt })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, endpoint, 200, responseBody);

    return updatedDebt;
  }, DEBT_TRANSACTION_OPTIONS);

  return updated;
}

export async function disputeDebt(debtId: string, input: DebtStatusActionInput, actor: Actor, idempotencyKey: string) {
  const endpoint = `POST /debts/${debtId}/dispute`;
  const updated = await transitionDebtStatus(
    debtId,
    actor,
    idempotencyKey,
    endpoint,
    {
      where: (status) => status !== "paid" && status !== "written_off" && status !== "disputed",
      errorMessage: (status) => `Cannot dispute a debt that is already ${status}`,
    },
    "disputed",
    "debt.disputed",
    input.reason
  );
  domainEvents.publish("DebtDisputed", { debtId, businessId: actor.businessId, reason: input.reason });
  return updated;
}

export async function resolveDisputeDebt(debtId: string, input: DebtStatusActionInput, actor: Actor, idempotencyKey: string) {
  const endpoint = `POST /debts/${debtId}/resolve-dispute`;
  return transitionDebtStatus(
    debtId,
    actor,
    idempotencyKey,
    endpoint,
    {
      where: (status) => status === "disputed",
      errorMessage: () => "Debt is not currently disputed",
    },
    (debt) => recomputeStatus("open", debt.amount_remaining, debt.amount_original),
    "debt.resolved",
    input.reason
  );
}

export async function writeOffDebt(debtId: string, input: DebtStatusActionInput, actor: Actor, idempotencyKey: string) {
  const endpoint = writeOffEndpoint(debtId);
  const updated = await transitionDebtStatus(
    debtId,
    actor,
    idempotencyKey,
    endpoint,
    {
      where: (status) => status !== "paid" && status !== "written_off",
      errorMessage: (status) => `Cannot write off a debt that is already ${status}`,
    },
    "written_off",
    "debt.written_off",
    input.reason
  );
  domainEvents.publish("DebtWrittenOff", { debtId, businessId: actor.businessId, reason: input.reason });
  return updated;
}

// Claims a (debt_id, reminder_type, business_date) slot for sending, or
// returns null if it's already spoken for (sent, currently in-flight
// elsewhere, or a failed attempt not yet eligible for retry). Two distinct
// atomic paths, both DB-guarded, never a SELECT-then-decide race:
//   - No row yet: INSERT relies on the table's own unique constraint --
//     a concurrent claim collides on P2002, not a lost-update.
//   - A `failed` row past its next_retry: re-claimed via an UPDATE guarded
//     by `WHERE id = ... AND status = 'failed'` -- if two retry attempts
//     race, only the first UPDATE actually matches a row (the second sees
//     status already flipped to 'pending' and updates zero rows), the exact
//     same atomic-conditional-update pattern used everywhere else in this
//     codebase (never blindly trust the earlier read).
// "Retry logic continues to use the existing reminder history table" --
// there is no separate retry queue/table, debt_reminders is it.
async function claimReminderSlot(
  businessId: string,
  debtId: string,
  reminderType: "before_due" | "overdue",
  businessDate: Date
): Promise<{ id: string } | null> {
  const existing = await prisma.debt_reminders.findUnique({
    where: { debt_id_reminder_type_business_date: { debt_id: debtId, reminder_type: reminderType, business_date: businessDate } },
  });

  if (!existing) {
    try {
      return await prisma.debt_reminders.create({
        data: {
          id: generateId(),
          business_id: businessId,
          debt_id: debtId,
          reminder_type: reminderType,
          business_date: businessDate,
          status: "pending",
          provider: "whatsapp",
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return null; // another call claimed it first -- already handled.
      }
      throw err;
    }
  }

  if (existing.status === "sent" || existing.status === "pending") return null;
  if (existing.next_retry && existing.next_retry > new Date()) return null; // not yet eligible for retry

  const reclaimResult = await prisma.debt_reminders.updateMany({
    where: { id: existing.id, status: "failed" },
    data: { status: "pending" },
  });
  return reclaimResult.count === 0 ? null : { id: existing.id };
}

// The ONLY implementation of reminder delivery in this repo -- called by both
// the manual endpoint (POST /debts/:id/remind) and reminderScheduler.ts's
// automated discovery loop. There is one send path, full stop; when future
// queue infrastructure (hardening roadmap Session 7+) replaces node-cron's
// tick loop, it still calls this exact function, never a second pathway.
// WhatsApp only, no automatic channel fallback (locked decision) -- a failed
// send is recorded, not silently retried on a different channel.
export async function sendReminder(debtId: string, actor: Actor) {
  const debt = await getOwned(prisma.debts.findUnique({ where: { id: debtId } }), actor.businessId, "Debt");
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });

  const today = getBusinessDay(business.timezone, business.business_day_start_time);
  const todayDate = new Date(today);
  const aging = computeAging(debt.date_due, today);
  const reminderType = aging.isOverdue ? "overdue" : "before_due";

  const claimed = await claimReminderSlot(actor.businessId, debtId, reminderType, todayDate);
  if (!claimed) {
    // Already sent today, currently being processed elsewhere, or a failed
    // attempt not yet due for retry -- skip safely, return current state.
    return prisma.debt_reminders.findFirstOrThrow({
      where: { debt_id: debtId, reminder_type: reminderType, business_date: todayDate },
    });
  }

  const body = aging.isOverdue
    ? `Reminder: your payment of ${debt.amount_remaining.toString()} was due on ${dateOnlyString(debt.date_due)} and is now overdue. Please settle as soon as possible.`
    : `Reminder: your payment of ${debt.amount_remaining.toString()} is due on ${dateOnlyString(debt.date_due)}.`;

  let status: "sent" | "failed" = "sent";
  let error: string | null = null;
  try {
    await getNotificationProvider().send({ category: "BUSINESS_OPERATIONS", channel: "whatsapp", to: debt.customer_phone, body });
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : "Unknown notification error";
  }

  const reminder = await prisma.$transaction(async (tx) => {
    const completed = await tx.debt_reminders.update({
      where: { id: claimed.id },
      data: {
        status,
        error,
        sent_at: status === "sent" ? new Date() : null,
        // Do not automatically switch channels -- only a fixed retry delay
        // for the same WhatsApp pathway, per the locked decision.
        next_retry: status === "failed" ? new Date(Date.now() + 60 * 60 * 1000) : null,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: status === "sent" ? "debt.reminder_sent" : "debt.reminder_failed",
      entityType: "debt_reminder",
      entityId: completed.id,
      reason: `${reminderType} reminder ${status} for debt ${debtId}${error ? `: ${error}` : ""}`,
    });

    return completed;
  });

  return reminder;
}

// Read Business Policy -> Calculate -> Audit -> Save. Uses the debt's OWN
// snapshotted policy fields (never a live Business Settings lookup -- see
// createDebt's snapshot comment). Manual trigger this session
// (POST /debts/:id/apply-interest) -- see the plan for why an automated
// accrual scheduler isn't built alongside the reminder one.
export async function applyInterest(debtId: string, input: ApplyInterestInput, actor: Actor, idempotencyKey: string) {
  const debt = await getOwned(prisma.debts.findUnique({ where: { id: debtId } }), actor.businessId, "Debt");
  if (debt.status === "paid" || debt.status === "written_off") {
    throw badRequest(`Cannot apply interest to a debt that is already ${debt.status}`);
  }
  if (!debt.interest_enabled || debt.interest_type === "none" || !debt.interest_value) {
    throw badRequest("Interest is not enabled for this debt");
  }

  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  const today = new Date(getBusinessDay(business.timezone, business.business_day_start_time));
  // last_interest_applied_at is a real wall-clock timestamp (unlike
  // date_taken/today, which are already UTC-midnight-anchored calendar
  // dates) -- date-fns' differenceInCalendarDays/Months (interestEngine.ts)
  // read local Date getters, so handing it in raw would make periodsElapsed
  // silently depend on the SERVER PROCESS's own local timezone instead of
  // Business.timezone. QA caught this. Bucket it into its own business-day
  // first, the same way `today` already is, before any calendar arithmetic.
  const lastAppliedOrTaken = debt.last_interest_applied_at
    ? new Date(getBusinessDay(business.timezone, business.business_day_start_time, debt.last_interest_applied_at))
    : debt.date_taken;
  const periodsElapsed = getPeriodsElapsed({
    calculationPolicy: debt.calculation_policy,
    lastAppliedOrTaken,
    today,
    alreadyAppliedOnce: debt.last_interest_applied_at !== null,
  });

  const interestAmount = calculateInterest({
    principal: debt.amount_original,
    remainingBalance: debt.amount_remaining,
    rate: debt.interest_value,
    type: debt.interest_type,
    formula: debt.formula,
    percentageBase: debt.percentage_base,
    periodsElapsed,
  });

  if (interestAmount.lessThanOrEqualTo(0)) {
    // Nothing due yet (e.g. one_time already applied, or not enough time
    // elapsed for the next period) -- not an error, just nothing to do.
    return { debt, transaction: null, periodsElapsed };
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, applyInterestEndpoint(debtId));

    const newRemaining = debt.amount_remaining.plus(interestAmount);
    // Interest only ever increases the balance, but a partially_paid debt
    // whose accrued interest pushes amount_remaining back up to/above
    // amount_original must revert to open -- status is purely derived from
    // the amounts (recomputeStatus), same rule every other balance-changing
    // debt mutation (recordPayment/reversePayment) already follows. QA caught
    // this being the one balance-changing path that skipped it.
    const newStatus = recomputeStatus(debt.status, newRemaining, debt.amount_original);

    const updateResult = await tx.debts.updateMany({
      where: { id: debtId, business_id: actor.businessId, version: input.version },
      data: { amount_remaining: newRemaining, status: newStatus, last_interest_applied_at: new Date(), version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Debt was modified concurrently, please retry with the latest version");
    }

    const transaction = await tx.debt_transactions.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        debt_id: debtId,
        transaction_type: "interest_applied",
        amount: interestAmount,
        balance_after: newRemaining,
        interest_type: debt.interest_type,
        interest_formula: debt.formula,
        percentage_base: debt.percentage_base,
        calculation_policy: debt.calculation_policy,
        interest_rate_applied: debt.interest_value,
        periods_elapsed: periodsElapsed,
        created_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "debt.interest_applied",
      entityType: "debt_transaction",
      entityId: transaction.id,
      reason: `Interest of ${interestAmount.toString()} applied to debt ${debtId} (${debt.interest_type}/${debt.formula}, ${periodsElapsed} period(s))`,
    });

    const updatedDebt = await tx.debts.findUniqueOrThrow({ where: { id: debtId } });
    const responseBody = JSON.parse(JSON.stringify({ data: { debt: updatedDebt, transaction } })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, applyInterestEndpoint(debtId), 201, responseBody);

    return { debt: updatedDebt, transaction };
  }, DEBT_TRANSACTION_OPTIONS);

  domainEvents.publish("InterestApplied", {
    debtId,
    businessId: actor.businessId,
    transactionId: result.transaction.id,
    amount: interestAmount.toString(),
    amountRemaining: result.debt.amount_remaining.toString(),
  });

  return { ...result, periodsElapsed };
}
