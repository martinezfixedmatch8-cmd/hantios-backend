import { Prisma, type payroll_records } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { getReplayedResponse, claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { getBusinessLocalYear, getBusinessLocalMonth } from "../lib/businessTime";
import { findEffectiveCompensation } from "./employeeCompensation.service";
import { getApprovedHoursForPeriod, getApprovedHoursByDayForPeriod } from "./attendance.service";
import { getEligibleSalesForPeriod } from "./commission.service";
import { generateReceiptInTransaction, buildPayrollReceiptSnapshot, requestReceiptDelivery } from "./receipt.service";
import { resolveListQuery, paginate, type PaginationQuery } from "../lib/pagination";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

const PAYROLL_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ============================================================================
// Generation -- one atomic INSERT ... ON CONFLICT DO NOTHING RETURNING per
// employee, same transaction-poisoning-avoidant pattern already proven
// correct in this repo (findOrCreateCustomer, getOrCreateWarehouse) --
// never a findFirst-then-create. The @@unique([business_id, employee_id,
// period_year, period_month]) constraint is what makes this genuinely
// concurrency-safe: two truly-simultaneous callers generating the same
// business+month both run this identically, and exactly one INSERT per
// employee ever lands.
//
// FIXED_MONTHLY (Session A), HOURLY (Session B), PERCENTAGE/
// FIXED_PLUS_PERCENTAGE (Session C), and FIXED_PLUS_TIME/CONTRACT/CUSTOM
// (Session D) have real calculation logic -- only PIECE_RATE remains
// SKIPPED (no authoritative output source exists anywhere in this repo --
// NOT CALCULABLE YET, confirmed Session D). An employee with no compensation
// structure at all for the period is also skipped. Zero approved hours/
// eligible sales for a period is NOT a skip reason -- per confirmed Phase
// 0, once the source of truth exists at all it always resolves to a real
// number, including a legitimate $0.00.
// ============================================================================

export interface GeneratePayrollResult {
  generated: { employeeId: string; payrollRecordId: string }[];
  skipped: { employeeId: string; reason: string }[];
  alreadyExisted: { employeeId: string }[];
}

export async function generatePayrollForBusiness(businessId: string, periodYear: number, periodMonth: number): Promise<GeneratePayrollResult> {
  // Batch 3 remediation -- deliberately LEFT AS Date.UTC, not migrated to
  // getBusinessMonthBounds. This value is used exclusively below to query
  // findEffectiveCompensation, which compares it against
  // employee_compensation.effective_from/effective_to -- both plain
  // @db.Date columns with no time-of-day or timezone meaning at all
  // (Postgres DATE, not TIMESTAMPTZ). periodYear/periodMonth are already
  // resolved in the business's own local calendar by every real caller
  // (generatePayrollForAllBusinesses/generatePayrollHandler both use
  // getBusinessLocalYear/getBusinessLocalMonth), so Date.UTC(year,
  // month-1, 1) here is the CORRECT bare-calendar-date representation of
  // "day 1 of that period" -- feeding getBusinessMonthBounds' own
  // business-timezone-SHIFTED instant into this comparison instead would
  // introduce a new bug (comparing a shifted instant against a naive
  // calendar-date column), not fix one. Confirmed and locked during Batch
  // 3's own Phase 0 review; see businessTime.ts's own getBusinessMonthBounds
  // comment for the fuller reasoning, and attendance.service.ts's matching
  // comment on its own two structurally-identical, deliberately-unchanged
  // call sites.
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });
  const employees = await prisma.employees.findMany({ where: { business_id: businessId, status: "active" } });

  const result: GeneratePayrollResult = { generated: [], skipped: [], alreadyExisted: [] };

  for (const employee of employees) {
    const compensation = await findEffectiveCompensation(businessId, employee.id, periodStart);
    if (!compensation) {
      result.skipped.push({ employeeId: employee.id, reason: "No compensation structure is effective for this period" });
      continue;
    }

    let amount: Prisma.Decimal;
    let hoursCalculated: Prisma.Decimal | null = null;
    let hourlyRate: Prisma.Decimal | null = null;
    let calculationBreakdown: Record<string, unknown> | null = null;

    if (compensation.compensation_model === "FIXED_MONTHLY") {
      const config = compensation.compensation_config as unknown as { monthlySalary: number };
      amount = new Prisma.Decimal(config.monthlySalary);
    } else if (compensation.compensation_model === "HOURLY") {
      // Calculation Snapshot (Module 12 Session B) -- Approved Hours x
      // rate, rounded ONCE at the single point it's first computed, same
      // "round once, use that value everywhere downstream" rule Sale's own
      // line-item-subtotal rounding fix already established.
      const config = compensation.compensation_config as unknown as { hourlyRate: number };
      const approvedHours = await getApprovedHoursForPeriod(businessId, employee.id, periodYear, periodMonth);
      const rate = new Prisma.Decimal(config.hourlyRate);
      hoursCalculated = approvedHours.toDecimalPlaces(2);
      hourlyRate = rate.toDecimalPlaces(2);
      amount = approvedHours.mul(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    } else if (compensation.compensation_model === "PERCENTAGE") {
      // Calculation Snapshot (Module 12 Session C) -- commissionRate is a
      // PERCENTAGE value (5.00 means 5%), confirmed Phase 0. eligibleSales
      // already correctly nets refunds via getEligibleSalesForPeriod's own
      // status+timestamp filtering -- no extra netting logic needed here.
      const config = compensation.compensation_config as unknown as { commissionRate: number };
      const eligibleSales = await getEligibleSalesForPeriod(businessId, employee.id, periodYear, periodMonth, business.timezone);
      const rate = new Prisma.Decimal(config.commissionRate);
      amount = eligibleSales.mul(rate).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      calculationBreakdown = {
        type: "PERCENTAGE",
        eligibleSales: eligibleSales.toDecimalPlaces(2).toString(),
        commissionRate: rate.toDecimalPlaces(2).toString(),
      };
    } else if (compensation.compensation_model === "FIXED_PLUS_PERCENTAGE") {
      // Confirmed zero-ambiguity extension -- purely additive, base +
      // commission, no threshold/overtime-style question.
      const config = compensation.compensation_config as unknown as { fixedBase: number; commissionRate: number };
      const eligibleSales = await getEligibleSalesForPeriod(businessId, employee.id, periodYear, periodMonth, business.timezone);
      const rate = new Prisma.Decimal(config.commissionRate);
      const fixedBase = new Prisma.Decimal(config.fixedBase);
      const commission = eligibleSales.mul(rate).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      amount = fixedBase.toDecimalPlaces(2).plus(commission);
      calculationBreakdown = {
        type: "FIXED_PLUS_PERCENTAGE",
        fixedBase: fixedBase.toDecimalPlaces(2).toString(),
        eligibleSales: eligibleSales.toDecimalPlaces(2).toString(),
        commissionRate: rate.toDecimalPlaces(2).toString(),
        commission: commission.toString(),
      };
    } else if (compensation.compensation_model === "FIXED_PLUS_TIME") {
      // Module 12 Session D -- confirmed Phase 0: threshold applied PER
      // DAY, using attendance_records' own per-row shape directly (no
      // aggregation-then-threshold). getApprovedHoursForPeriod (HOURLY's
      // own, already-shipped path) is untouched -- this uses the new,
      // additive getApprovedHoursByDayForPeriod instead.
      const config = compensation.compensation_config as unknown as {
        fixedAmount: number;
        hourlyRate: number;
        overtimeThresholdHours: number;
        overtimeMultiplier: number;
      };
      const dayHours = await getApprovedHoursByDayForPeriod(businessId, employee.id, periodYear, periodMonth);
      const threshold = new Prisma.Decimal(config.overtimeThresholdHours);
      const rate = new Prisma.Decimal(config.hourlyRate);
      const multiplier = new Prisma.Decimal(config.overtimeMultiplier);
      const fixedAmount = new Prisma.Decimal(config.fixedAmount);

      let totalNormalHours = new Prisma.Decimal(0);
      let totalOvertimeHours = new Prisma.Decimal(0);
      for (const day of dayHours) {
        const normal = day.hours.greaterThan(threshold) ? threshold : day.hours;
        const overtimeRaw = day.hours.minus(threshold);
        const overtime = overtimeRaw.greaterThan(0) ? overtimeRaw : new Prisma.Decimal(0);
        totalNormalHours = totalNormalHours.plus(normal);
        totalOvertimeHours = totalOvertimeHours.plus(overtime);
      }
      const normalPay = totalNormalHours.mul(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const overtimePay = totalOvertimeHours.mul(rate).mul(multiplier).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      amount = fixedAmount.toDecimalPlaces(2).plus(normalPay).plus(overtimePay);
      calculationBreakdown = {
        type: "FIXED_PLUS_TIME",
        fixedAmount: fixedAmount.toDecimalPlaces(2).toString(),
        normalHours: totalNormalHours.toDecimalPlaces(2).toString(),
        overtimeHours: totalOvertimeHours.toDecimalPlaces(2).toString(),
        hourlyRate: rate.toDecimalPlaces(2).toString(),
        overtimeMultiplier: multiplier.toDecimalPlaces(2).toString(),
        normalPay: normalPay.toString(),
        overtimePay: overtimePay.toString(),
      };
    } else if (compensation.compensation_model === "CONTRACT") {
      // Module 12 Session D, Locked Decision #2 -- employee_compensation
      // itself IS the Compensation Agreement (Path B, confirmed -- no new
      // module). MONTHLY schedule only this session; any other
      // paymentSchedule value is already rejected at the Zod layer.
      const config = compensation.compensation_config as unknown as {
        contractAmount: number;
        contractPeriodMonths: number;
        paymentSchedule: string;
      };
      const contractAmount = new Prisma.Decimal(config.contractAmount);
      amount = contractAmount.dividedBy(config.contractPeriodMonths).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      calculationBreakdown = {
        type: "CONTRACT",
        contractAmount: contractAmount.toDecimalPlaces(2).toString(),
        contractPeriodMonths: config.contractPeriodMonths,
        paymentSchedule: config.paymentSchedule,
      };
    } else if (compensation.compensation_model === "CUSTOM") {
      // Module 12 Session D, Locked Decision #6 -- "Composable
      // Compensation" (CUSTOM v1, confirmed bounded, NOT a rules engine).
      // Each present component reuses the EXACT SAME calculation path its
      // own dedicated model already uses -- zero duplicated math. Field
      // names below mirror fixedMonthlyConfigSchema/hourlyConfigSchema/
      // percentageConfigSchema exactly (monthlySalary/hourlyRate/
      // commissionRate) -- these are the SAME sub-schemas customConfigSchema
      // itself reuses, not a fresh shape invented for CUSTOM.
      const config = compensation.compensation_config as unknown as {
        fixedComponent?: { monthlySalary: number };
        hourlyComponent?: { hourlyRate: number };
        percentageComponent?: { commissionRate: number };
      };
      let total = new Prisma.Decimal(0);
      const components: Record<string, unknown>[] = [];

      if (config.fixedComponent) {
        const componentAmount = new Prisma.Decimal(config.fixedComponent.monthlySalary).toDecimalPlaces(2);
        total = total.plus(componentAmount);
        components.push({ type: "fixed", amount: componentAmount.toString() });
      }
      if (config.hourlyComponent) {
        const approvedHours = await getApprovedHoursForPeriod(businessId, employee.id, periodYear, periodMonth);
        const rate = new Prisma.Decimal(config.hourlyComponent.hourlyRate);
        const componentAmount = approvedHours.mul(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        total = total.plus(componentAmount);
        components.push({
          type: "hourly",
          hours: approvedHours.toDecimalPlaces(2).toString(),
          rate: rate.toDecimalPlaces(2).toString(),
          amount: componentAmount.toString(),
        });
      }
      if (config.percentageComponent) {
        const eligibleSales = await getEligibleSalesForPeriod(businessId, employee.id, periodYear, periodMonth, business.timezone);
        const rate = new Prisma.Decimal(config.percentageComponent.commissionRate);
        const componentAmount = eligibleSales.mul(rate).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        total = total.plus(componentAmount);
        components.push({
          type: "percentage",
          eligibleSales: eligibleSales.toDecimalPlaces(2).toString(),
          rate: rate.toDecimalPlaces(2).toString(),
          amount: componentAmount.toString(),
        });
      }

      amount = total;
      calculationBreakdown = { type: "CUSTOM", components, total: total.toString() };
    } else {
      result.skipped.push({ employeeId: employee.id, reason: `Compensation model "${compensation.compensation_model}" has no real calculation logic yet (no source of truth -- NOT CALCULABLE YET)` });
      continue;
    }

    const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO payroll_records (id, business_id, employee_id, period_year, period_month, compensation_id, compensation_model, amount, currency_code, hours_calculated, hourly_rate, calculation_breakdown, status, created_at, version)
      VALUES (${generateId()}, ${businessId}, ${employee.id}, ${periodYear}, ${periodMonth}, ${compensation.id}, ${compensation.compensation_model}::"CompensationModel", ${amount}, ${compensation.currency_code}, ${hoursCalculated}, ${hourlyRate}, ${calculationBreakdown ? JSON.stringify(calculationBreakdown) : null}::jsonb, 'pending', now(), 0)
      ON CONFLICT (business_id, employee_id, period_year, period_month) DO NOTHING
      RETURNING id
    `);

    if (rows.length === 0) {
      result.alreadyExisted.push({ employeeId: employee.id });
      continue;
    }

    result.generated.push({ employeeId: employee.id, payrollRecordId: rows[0].id });
    domainEvents.publish("PayrollRecordCreated", {
      businessId,
      payrollRecordId: rows[0].id,
      employeeId: employee.id,
      periodYear,
      periodMonth,
    });
  }

  return result;
}

// Lazy/manual fallback -- POST /payroll/generate. Defaults to the
// business's own current local calendar month when not given explicitly,
// same business-timezone-aware reasoning as the scheduler. Naturally
// idempotent (same atomic INSERT ... ON CONFLICT DO NOTHING underneath),
// so no Idempotency-Key is required on this endpoint -- calling it twice
// for the same month just finds nothing new the second time.
export async function generatePayrollHandler(businessId: string, periodYear?: number, periodMonth?: number): Promise<GeneratePayrollResult> {
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
  const year = periodYear ?? getBusinessLocalYear(business.timezone);
  const month = periodMonth ?? getBusinessLocalMonth(business.timezone);
  return generatePayrollForBusiness(businessId, year, month);
}

// Cron-driven primary generation, mirroring reminderScheduler.ts's own
// shape exactly -- called from payrollScheduler.ts. Lazy/manual fallback
// (generatePayrollHandler below, POST /payroll/generate) covers edge cases
// (a business created mid-month, a missed tick): both paths funnel through
// the exact same generatePayrollForBusiness, so the DB-level guarantee is
// identical regardless of which one fired.
export async function generatePayrollForAllBusinesses(): Promise<void> {
  const businesses = await prisma.businesses.findMany({ select: { id: true, timezone: true } });
  for (const business of businesses) {
    const year = getBusinessLocalYear(business.timezone);
    const month = getBusinessLocalMonth(business.timezone);
    await generatePayrollForBusiness(business.id, year, month);
  }
}

// ============================================================================
// Read side
// ============================================================================

export interface ListPayrollQuery extends PaginationQuery {
  status?: string;
  employeeId?: string;
  periodYear?: number;
  periodMonth?: number;
}

export async function listPayrollRecords(query: ListPayrollQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["created_at", "period_year", "period_month"] as const,
    defaultSort: "created_at" as const,
  });

  const where: Prisma.payroll_recordsWhereInput = {
    business_id: businessId,
    ...(query.status ? { status: query.status as "pending" | "paid" } : {}),
    ...(query.employeeId ? { employee_id: query.employeeId } : {}),
    ...(query.periodYear ? { period_year: query.periodYear } : {}),
    ...(query.periodMonth ? { period_month: query.periodMonth } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.payroll_records.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.payroll_records.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

// Module 12 Session C -- bundles its own commission_adjustments on the
// read, same "bundle related records on the parent's read endpoint"
// pattern as Expenses/PO GRN/Attendance's own adjustments.
// Module 12 Session D, Locked Decision #3 -- bundles BOTH correction
// mechanisms (Session C's commission_adjustments and this session's own
// payroll_reversals) and a computed effectiveAmount = amount +
// Sum(commission_adjustments.delta_amount) + Sum(payroll_reversals.delta_
// amount), unifying them into one real number. Computed fresh on every
// read, never stored -- amount itself is never rewritten by either
// mechanism (Calculation Snapshot preserved). This is what makes "what was
// actually paid, and why did it change" answerable from one call.
export async function getPayrollRecord(id: string, businessId: string) {
  const record = await getOwned(
    prisma.payroll_records.findUnique({
      where: { id },
      include: { commission_adjustments: true, payroll_reversals: true },
    }),
    businessId,
    "Payroll record"
  );

  const effectiveAmount = computeEffectiveAmount(record.amount, record.payroll_reversals, record.commission_adjustments);

  return { ...record, effectiveAmount: effectiveAmount.toString() };
}

// ============================================================================
// Mark-as-paid -- atomic status-guarded transition (Final State Protection,
// same shape as Sale Void/Refund), Payroll Receipt generation (7th Module 06
// type) inside the SAME transaction (No Orphan Receipts), and an automatic
// WhatsApp delivery attempt fired post-commit -- fulfilling the locked "a
// payroll receipt is sent via WhatsApp once marked paid" requirement for
// real, reusing Module 06's own requestReceiptDelivery rather than
// duplicating WhatsApp-send logic. Best-effort/non-blocking: a delivery
// failure never undoes the payment having been recorded (same "money
// already moved is never undone by a downstream notification failing"
// principle this repo already applies everywhere).
// ============================================================================

export function markPayrollPaidEndpoint(id: string): string {
  return `POST /payroll/${id}/mark-paid`;
}

export interface MarkPayrollPaidInput {
  version: number;
  paymentMethodId?: string;
  paymentReference?: string;
}

export async function markPayrollPaid(id: string, input: MarkPayrollPaidInput, actor: Actor, idempotencyKey: string) {
  // Checked HERE, inside the service, rather than only at the controller
  // layer (this repo's usual convention) -- markPayrollPaid has TWO real
  // call sites, the single mark-paid endpoint AND bulkPayPending's own
  // per-employee loop below, and both need a genuine retry to replay
  // cleanly rather than 409ing on an already-claimed key. Without this, a
  // retried bulk-pay call would show every already-paid employee as
  // "failed" instead of correctly replaying their own prior success.
  const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, markPayrollPaidEndpoint(id));
  if (replayed) {
    return (replayed.body as { data: payroll_records }).data;
  }

  const record = await getOwned(prisma.payroll_records.findUnique({ where: { id } }), actor.businessId, "Payroll record");
  if (record.status === "paid") {
    throw badRequest("This payroll record is already marked paid");
  }
  if (input.paymentMethodId) {
    await getOwned(prisma.payment_methods.findUnique({ where: { id: input.paymentMethodId } }), actor.businessId, "Payment method");
  }

  const employee = await getOwned(prisma.employees.findUnique({ where: { id: record.employee_id } }), actor.businessId, "Employee");
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  const position = employee.position_id ? await prisma.positions.findUnique({ where: { id: employee.position_id } }) : null;
  const paymentMethod = input.paymentMethodId ? await prisma.payment_methods.findUnique({ where: { id: input.paymentMethodId } }) : null;

  const { record: updatedRecord, receipt: payrollReceipt } = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, markPayrollPaidEndpoint(id));

    const paidAt = new Date();
    // Atomic guarded transition -- covers "already paid" and "modified
    // concurrently" identically, one statement. This is the REAL guard
    // against a duplicate PAYMENT (two requests racing to pay the same
    // still-pending record); the @@unique constraint on the record itself
    // is what guarantees only one record ever existed to race over.
    const updateResult = await tx.payroll_records.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "pending" },
      data: {
        status: "paid",
        payment_method_id: input.paymentMethodId ?? null,
        payment_reference: input.paymentReference ?? null,
        paid_at: paidAt,
        paid_by: actor.userId,
        version: { increment: 1 },
      },
    });
    if (updateResult.count === 0) {
      throw conflict("Payroll record is not in a payable state (already paid, or was modified concurrently)");
    }

    const periodLabel = `${MONTH_NAMES[record.period_month - 1]} ${record.period_year}`;
    const receipt = await generateReceiptInTransaction(tx, {
      businessId: actor.businessId,
      timezone: business.timezone,
      settings: business.settings,
      currencyCode: record.currency_code,
      receiptType: "payroll",
      source: { payrollRecordId: id },
      subtotal: record.amount,
      total: record.amount,
      snapshot: buildPayrollReceiptSnapshot(business, paymentMethod?.name ?? null, {
        employeeName: employee.name,
        position: position?.title ?? null,
        periodLabel,
        compensationModel: record.compensation_model,
        amount: record.amount.toString(),
      }),
      createdBy: actor.userId,
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "payroll.marked_paid",
      entityType: "payroll_record",
      entityId: id,
      reason: `Salary for "${employee.name}" (${periodLabel}) marked paid, ${record.amount.toString()} ${record.currency_code}`,
    });

    const updated = await tx.payroll_records.findUniqueOrThrow({ where: { id } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, markPayrollPaidEndpoint(id), 200, responseBody);

    return { record: updated, receipt };
  }, PAYROLL_TRANSACTION_OPTIONS);

  domainEvents.publish("PayrollMarkedPaid", {
    businessId: actor.businessId,
    payrollRecordId: id,
    employeeId: record.employee_id,
    amount: updatedRecord.amount.toString(),
  });
  domainEvents.publish("ReceiptGenerated", {
    businessId: actor.businessId,
    receiptId: payrollReceipt.id,
    receiptNumber: payrollReceipt.receipt_number,
    receiptType: payrollReceipt.receipt_type,
  });

  // Automatic WhatsApp delivery, fire-and-forget -- a delivery failure must
  // never surface as a failure of the payment action itself (the money has
  // already, truthfully, been marked as moved). A deterministic key
  // (derived from the receipt id, not random) means a crash-and-retry of
  // THIS specific call never double-sends via requestReceiptDelivery's own
  // idempotency layer.
  requestReceiptDelivery(payrollReceipt.id, { channel: "whatsapp" }, actor, `auto-payroll-${payrollReceipt.id}`).catch((err) => {
    console.error(`[payroll] automatic WhatsApp receipt delivery failed for payroll record ${id}:`, err instanceof Error ? err.message : err);
  });

  return updatedRecord;
}

// ============================================================================
// Bulk "Pay All Pending" -- each employee's mark-as-paid is its OWN
// independent atomic unit (its own transaction, its own Idempotency-Key
// scope inside markPayrollPaid), never one giant transaction -- one
// employee's failure (stale version, already paid by a concurrent request,
// etc.) never rolls back anyone else's success. Explicit succeeded/failed
// reporting, per the confirmed design.
// ============================================================================

export interface BulkPayPendingInput {
  paymentMethodId?: string;
  paymentReference?: string;
}

export interface BulkPayPendingResult {
  succeeded: { employeeId: string; payrollRecordId: string }[];
  failed: { employeeId: string; payrollRecordId: string; reason: string }[];
}

export const BULK_PAY_PENDING_ENDPOINT = "POST /payroll/pay-all-pending";

// Two idempotency layers, same reasoning as receipt.service.ts's own
// delivery endpoint: Layer 1 is this bulk-level claim/complete, wrapping
// the WHOLE summary response (a genuine retry of the whole bulk call
// returns the exact same succeeded/failed summary without re-running
// anything). Layer 2 is each employee's own claim inside markPayrollPaid
// (see its own comment) -- defense-in-depth, and what actually protects
// bulkPayPending from ever being called a second way that bypasses this
// wrapper.
export async function bulkPayPending(input: BulkPayPendingInput, actor: Actor, idempotencyKey: string): Promise<BulkPayPendingResult> {
  await prisma.$transaction((tx) => claimIdempotencyKey(tx, actor.businessId, idempotencyKey, BULK_PAY_PENDING_ENDPOINT));

  const pending = await prisma.payroll_records.findMany({
    where: { business_id: actor.businessId, status: "pending" },
  });

  const result: BulkPayPendingResult = { succeeded: [], failed: [] };

  for (const record of pending) {
    try {
      // idempotencyKey here is the SAME bulk-level key, reused as-is for
      // every employee's own underlying markPayrollPaid call -- this works
      // correctly (never cross-contaminates between employees) because
      // markPayrollPaidEndpoint(id) already scopes the claim's own
      // (business_id, key, endpoint) uniqueness by the payroll record's own
      // id, so N employees sharing one bulk key still produce N distinct
      // claims.
      await markPayrollPaid(
        record.id,
        { version: record.version, paymentMethodId: input.paymentMethodId, paymentReference: input.paymentReference },
        actor,
        idempotencyKey
      );
      result.succeeded.push({ employeeId: record.employee_id, payrollRecordId: record.id });
    } catch (err) {
      result.failed.push({
        employeeId: record.employee_id,
        payrollRecordId: record.id,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const responseBody = JSON.parse(JSON.stringify({ data: result })) as unknown;
  await prisma.$transaction((tx) => completeIdempotencyKey(tx, actor.businessId, idempotencyKey, BULK_PAY_PENDING_ENDPOINT, 200, responseBody));

  return result;
}

// ============================================================================
// Module 12 Session D, Locked Decision #3 -- the PAID Payroll Reversal
// Ledger. Once a payroll_records row is PAID it is never edited in place
// (locked since Session A) -- this is the mechanism for correcting a PAID
// record's financial history without destroying it, mirroring
// attendance_adjustments (Session B) and commission_adjustments (Session
// C) exactly: immutable, signed, linked, reason required. Validated at
// creation: target record must be status="paid" -- a reversal against a
// still-pending record doesn't make sense (a pending record should just
// be corrected before payment, not reversed).
// ============================================================================

export const createPayrollReversalEndpoint = (payrollRecordId: string): string => `POST /payroll/${payrollRecordId}/reversals`;

export interface CreatePayrollReversalInput {
  deltaAmount: number;
  reason: string;
}

// HNT-PAY-003 remediation -- the SAME computation getPayrollRecord's own
// effectiveAmount already uses (amount + every reversal's delta + every
// commission adjustment's delta), extracted so the bound check below
// reuses it exactly rather than duplicating the arithmetic.
function computeEffectiveAmount(
  amount: Prisma.Decimal,
  reversals: { delta_amount: Prisma.Decimal }[],
  commissionAdjustments: { delta_amount: Prisma.Decimal }[]
): Prisma.Decimal {
  return commissionAdjustments.reduce((sum, a) => sum.plus(a.delta_amount), reversals.reduce((sum, r) => sum.plus(r.delta_amount), amount));
}

// Confirmed business policy (HNT-PAY-003): effectiveAmount must stay >= 0.
// No separate cap on the upside -- a positive correction (e.g. a bonus or
// back-pay adjustment) can legitimately push effectiveAmount above the
// original amount, that's not a bug.
export async function createPayrollReversal(
  payrollRecordId: string,
  input: CreatePayrollReversalInput,
  actor: Actor,
  idempotencyKey: string
) {
  const endpoint = createPayrollReversalEndpoint(payrollRecordId);
  const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, endpoint);
  if (replayed) {
    return (replayed.body as { data: Awaited<ReturnType<typeof prisma.payroll_reversals.create>> }).data;
  }

  const record = await getOwned(prisma.payroll_records.findUnique({ where: { id: payrollRecordId } }), actor.businessId, "Payroll record");
  if (record.status !== "paid") {
    throw badRequest("A reversal can only be created against a PAID payroll record -- correct a still-pending record directly instead");
  }

  const reversal = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, endpoint);

    // HNT-PAY-003 fix -- lock the payroll record row so two concurrent
    // reversals against the SAME record can never both read the same
    // starting effectiveAmount and jointly push it out of bounds; re-read
    // the reversal/adjustment history under that lock (never a stale
    // pre-transaction read) before deciding whether this new delta is
    // acceptable.
    await tx.$queryRaw`SELECT id FROM payroll_records WHERE id = ${payrollRecordId} FOR UPDATE`;

    const [existingReversals, existingCommissionAdjustments] = await Promise.all([
      tx.payroll_reversals.findMany({ where: { payroll_record_id: payrollRecordId }, select: { delta_amount: true } }),
      tx.commission_adjustments.findMany({ where: { payroll_record_id: payrollRecordId }, select: { delta_amount: true } }),
    ]);
    const deltaAmount = new Prisma.Decimal(input.deltaAmount);
    const currentEffective = computeEffectiveAmount(record.amount, existingReversals, existingCommissionAdjustments);
    const projectedEffective = currentEffective.plus(deltaAmount);
    if (projectedEffective.lessThan(0)) {
      throw badRequest(
        `This reversal would bring the effective paid amount to ${projectedEffective.toString()}, which is negative -- the effective amount must stay >= 0 (currently ${currentEffective.toString()})`
      );
    }

    const created = await tx.payroll_reversals.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        payroll_record_id: payrollRecordId,
        delta_amount: deltaAmount,
        reason: input.reason,
        created_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "payroll.reversal_created",
      entityType: "payroll_record",
      entityId: payrollRecordId,
      reason: `Reversal for paid payroll record: ${input.deltaAmount} (${input.reason})`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, endpoint, 201, responseBody);

    return created;
  });

  domainEvents.publish("PayrollReversalCreated", {
    businessId: actor.businessId,
    payrollReversalId: reversal.id,
    payrollRecordId,
    deltaAmount: reversal.delta_amount.toString(),
    occurredAt: reversal.created_at.toISOString(),
  });

  return reversal;
}
