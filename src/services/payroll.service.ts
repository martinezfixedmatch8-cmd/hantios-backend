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
// Only FIXED_MONTHLY has real calculation logic this session -- an
// employee whose currently-effective compensation is any other model (or
// has no compensation structure at all) is SKIPPED, never silently given
// a wrong/zero amount, and never aborts generation for other employees.
// ============================================================================

export interface GeneratePayrollResult {
  generated: { employeeId: string; payrollRecordId: string }[];
  skipped: { employeeId: string; reason: string }[];
  alreadyExisted: { employeeId: string }[];
}

export async function generatePayrollForBusiness(businessId: string, periodYear: number, periodMonth: number): Promise<GeneratePayrollResult> {
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const employees = await prisma.employees.findMany({ where: { business_id: businessId, status: "active" } });

  const result: GeneratePayrollResult = { generated: [], skipped: [], alreadyExisted: [] };

  for (const employee of employees) {
    const compensation = await findEffectiveCompensation(businessId, employee.id, periodStart);
    if (!compensation) {
      result.skipped.push({ employeeId: employee.id, reason: "No compensation structure is effective for this period" });
      continue;
    }
    if (compensation.compensation_model !== "FIXED_MONTHLY") {
      result.skipped.push({ employeeId: employee.id, reason: `Compensation model "${compensation.compensation_model}" has no real calculation logic yet (Session B/C)` });
      continue;
    }
    const config = compensation.compensation_config as unknown as { monthlySalary: number };
    const amount = new Prisma.Decimal(config.monthlySalary);

    const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO payroll_records (id, business_id, employee_id, period_year, period_month, compensation_id, compensation_model, amount, currency_code, status, created_at, version)
      VALUES (${generateId()}, ${businessId}, ${employee.id}, ${periodYear}, ${periodMonth}, ${compensation.id}, 'FIXED_MONTHLY', ${amount}, ${compensation.currency_code}, 'pending', now(), 0)
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

export async function getPayrollRecord(id: string, businessId: string) {
  return getOwned(prisma.payroll_records.findUnique({ where: { id } }), businessId, "Payroll record");
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
