import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict, notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { getBusinessDay, dateOnlyString } from "../lib/businessTime";
import { getReplayedResponse, claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { resolveListQuery, paginate } from "../lib/pagination";
import type {
  CreateAttendanceRecordInput,
  BulkCreateAttendanceInput,
  ListAttendanceQuery,
  CreateAttendanceAdjustmentInput,
} from "../validation/attendance.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const RECORD_ATTENDANCE_ENDPOINT = "POST /attendance";
// Bulk scopes each entry's own idempotency claim by employee+workDate, not
// a pre-existing record id (there isn't one yet at creation time, unlike
// Payroll's own bulk-pay which scopes by an already-existing payroll
// record id) -- N entries sharing one bulk-level key still produce N
// distinct claims, same reasoning as markPayrollPaidEndpoint(id).
const bulkEntryEndpoint = (employeeId: string, workDateStr: string): string => `POST /attendance/bulk/${employeeId}/${workDateStr}`;
export const createAttendanceAdjustmentEndpoint = (attendanceRecordId: string): string => `POST /attendance/${attendanceRecordId}/adjustments`;
export const RECORD_SELF_ATTENDANCE_ENDPOINT = "POST /attendance/self";

// Confirmed Phase 0 (Q1/Q2): the ONE write path this session builds is an
// authorized role (owner/manager) recording attendance on an employee's own
// behalf -- recording and approval collapse into this single action, but
// the approved state is still explicitly, directly persisted (never
// inferred from who recorded it). Confirmed Phase 0 (Q3): workDate is
// explicitly client-supplied (back-dated entry allowed), validated only as
// not later than the business's own current business day.
async function assertWorkDateNotInFuture(businessId: string, workDate: Date): Promise<void> {
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
  const today = getBusinessDay(business.timezone, business.business_day_start_time, new Date());
  const workDateStr = dateOnlyString(workDate);
  if (workDateStr > today) {
    throw badRequest(`workDate (${workDateStr}) cannot be later than the business's own current business day (${today})`);
  }
}

async function createAttendanceRecordEntry(
  input: CreateAttendanceRecordInput,
  actor: Actor,
  idempotencyKey: string,
  endpoint: string,
  options: { selfService?: boolean } = {}
) {
  // Checked internally, not just by the caller -- this function has two
  // real call sites (the single record endpoint AND bulkRecordAttendance's
  // own per-entry loop), the same shape Payroll's markPayrollPaid already
  // established a real bug fix for in Session A: without this, a genuine
  // retry could hit an already-claimed per-entry key and report a false
  // failure instead of replaying the original success.
  const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, endpoint);
  if (replayed) {
    return (replayed.body as { data: Awaited<ReturnType<typeof prisma.attendance_records.create>> }).data;
  }

  await getOwned(prisma.employees.findUnique({ where: { id: input.employeeId } }), actor.businessId, "Employee");
  await assertWorkDateNotInFuture(actor.businessId, input.workDate);

  const record = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, endpoint);

    // Module 12 Session D -- self-service creates status:"recorded"
    // (Session B's own reserved-but-previously-unreachable value, made
    // reachable for real this session), never "approved" -- self-reported
    // attendance is not self-approved. Every other rule (duplicate-entry
    // guard, not-later-than-today validation, idempotency, audit log) is
    // shared unchanged between both paths.
    const selfService = options.selfService === true;
    let created;
    try {
      created = await tx.attendance_records.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          employee_id: input.employeeId,
          work_date: input.workDate,
          hours_worked: new Prisma.Decimal(input.hoursWorked),
          status: selfService ? "recorded" : "approved",
          recorded_by: actor.userId,
          approved_by: selfService ? null : actor.userId,
          approved_at: selfService ? null : new Date(),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw conflict("An attendance record already exists for this employee on this date -- use an adjustment to correct it, not a second entry");
      }
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "attendance.recorded",
      entityType: "attendance_record",
      entityId: created.id,
      reason: `Attendance recorded for employee ${input.employeeId} on ${dateOnlyString(input.workDate)}: ${input.hoursWorked}h`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, endpoint, 201, responseBody);

    return created;
  });

  domainEvents.publish("AttendanceRecorded", {
    businessId: actor.businessId,
    attendanceRecordId: record.id,
    employeeId: record.employee_id,
    workDate: dateOnlyString(record.work_date),
    hoursWorked: record.hours_worked.toString(),
    occurredAt: record.created_at.toISOString(),
  });

  return record;
}

export async function recordAttendance(input: CreateAttendanceRecordInput, actor: Actor, idempotencyKey: string) {
  return createAttendanceRecordEntry(input, actor, idempotencyKey, RECORD_ATTENDANCE_ENDPOINT);
}

// Module 12 Session D, Locked Decision #5 -- self-service, backend-only.
// Deliberately NO requireRole at the route level -- any authenticated user
// can call this; the real gate is whether they have a linked, active
// employee record, exactly the same "service decides, not RBAC role"
// pattern already established for Compensation Policy acknowledgement.
// employeeId is NEVER client-suppliable here -- resolved exclusively from
// the requesting user's own session (req.auth.userId), same "actor
// identity is never client-suppliable" rule every other module in this
// repo already follows. A user with no linked employees row is a real,
// common, expected case (most users aren't linked to a payroll employee
// at all) -- a clean 404, never a 500.
export async function recordSelfAttendance(
  input: { workDate: Date; hoursWorked: number },
  actor: Actor,
  idempotencyKey: string
) {
  const employee = await prisma.employees.findFirst({
    where: { business_id: actor.businessId, user_id: actor.userId, status: "active" },
  });
  if (!employee) {
    throw notFound("No active employee record is linked to your account");
  }

  return createAttendanceRecordEntry(
    { employeeId: employee.id, workDate: input.workDate, hoursWorked: input.hoursWorked },
    actor,
    idempotencyKey,
    RECORD_SELF_ATTENDANCE_ENDPOINT,
    { selfService: true }
  );
}

// Per-entry isolated, same partial-failure shape as Payroll's own
// bulkPayPending -- one employee's failure (a stale duplicate day, an
// unowned employee id) never blocks the rest of the roster.
export interface BulkAttendanceResult {
  succeeded: { employeeId: string; attendanceRecordId: string }[];
  failed: { employeeId: string; workDate: string; reason: string }[];
}

export async function bulkRecordAttendance(input: BulkCreateAttendanceInput, actor: Actor, idempotencyKey: string): Promise<BulkAttendanceResult> {
  const result: BulkAttendanceResult = { succeeded: [], failed: [] };

  for (const entry of input.entries) {
    const workDateStr = dateOnlyString(entry.workDate);
    try {
      const record = await createAttendanceRecordEntry(entry, actor, idempotencyKey, bulkEntryEndpoint(entry.employeeId, workDateStr));
      result.succeeded.push({ employeeId: entry.employeeId, attendanceRecordId: record.id });
    } catch (err) {
      result.failed.push({
        employeeId: entry.employeeId,
        workDate: workDateStr,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return result;
}

export async function listAttendanceRecords(query: ListAttendanceQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["work_date", "created_at"] as const,
    defaultSort: "work_date" as const,
    searchableFields: [],
  });

  const where = {
    business_id: businessId,
    ...(query.employeeId ? { employee_id: query.employeeId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.dateFrom || query.dateTo
      ? {
          work_date: {
            ...(query.dateFrom ? { gte: query.dateFrom } : {}),
            ...(query.dateTo ? { lte: query.dateTo } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.attendance_records.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.attendance_records.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

// Bundles its own adjustments on the read, same "bundle related records on
// the parent's read endpoint" pattern already established (Expenses'
// EXPENSE_INCLUDE, PO's GRN/Payment bundling).
export async function getAttendanceRecord(id: string, businessId: string) {
  return getOwned(
    prisma.attendance_records.findUnique({ where: { id }, include: { attendance_adjustments: true } }),
    businessId,
    "Attendance record"
  );
}

// Confirmed Phase 0 (Adjustment model): corrections to an already-approved
// attendance record never mutate or delete the original -- hours_worked is
// written once and never touched again. Validated here: the target record
// must be approved, and the resulting effective hours must not go negative.
// Accepted, narrow, documented gap (same class as the Reminder Scheduler's
// own accepted gap): this check runs inside the same transaction as the
// write but without a SELECT ... FOR UPDATE row lock, so two genuinely
// simultaneous adjustments against the SAME record could theoretically both
// read the same "current effective hours" and both pass the check. This is
// a low-frequency, single-operator corrective action (not a duplicate-
// payment-class guarantee), so the extra locking complexity isn't
// justified without a real incident showing this matters in practice.
export async function createAttendanceAdjustment(
  attendanceRecordId: string,
  input: CreateAttendanceAdjustmentInput,
  actor: Actor,
  idempotencyKey: string
) {
  const record = await getOwned(prisma.attendance_records.findUnique({ where: { id: attendanceRecordId } }), actor.businessId, "Attendance record");
  if (record.status !== "approved") {
    throw badRequest("Adjustments can only be made against an approved attendance record");
  }

  const endpoint = createAttendanceAdjustmentEndpoint(attendanceRecordId);

  const adjustment = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, endpoint);

    const existingAdjustments = await tx.attendance_adjustments.findMany({ where: { attendance_record_id: attendanceRecordId } });
    const currentEffective = existingAdjustments.reduce((sum, a) => sum.plus(a.delta_hours), record.hours_worked);
    const deltaHours = new Prisma.Decimal(input.deltaHours);
    if (currentEffective.plus(deltaHours).lessThan(0)) {
      throw badRequest("This adjustment would make the effective hours for this day negative");
    }

    const created = await tx.attendance_adjustments.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        attendance_record_id: attendanceRecordId,
        delta_hours: deltaHours,
        reason: input.reason,
        created_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "attendance.adjustment_created",
      entityType: "attendance_record",
      entityId: attendanceRecordId,
      reason: input.reason,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, endpoint, 201, responseBody);

    return created;
  });

  domainEvents.publish("AttendanceAdjustmentCreated", {
    businessId: actor.businessId,
    attendanceRecordId,
    adjustmentId: adjustment.id,
    deltaHours: adjustment.delta_hours.toString(),
    occurredAt: adjustment.created_at.toISOString(),
  });

  return adjustment;
}

// The single lookup Payroll's own HOURLY generation branch uses. Pure
// aggregation, no mutation: each approved record's OWN effective hours is
// its stored hours_worked plus the sum of every adjustment's own signed
// delta_hours -- hours_worked itself is never rewritten, only summed
// against at read time. Deliberately a plain Prisma fetch + JS
// Prisma.Decimal reduce, not raw SQL SUM: this is a small, single-employee,
// single-period aggregation, not a cross-employee list needing DB-side
// sorting/filtering (the one condition under which this repo reaches for
// raw SQL, e.g. listDebts' own aging CASE).
export async function getApprovedHoursForPeriod(
  businessId: string,
  employeeId: string,
  periodYear: number,
  periodMonth: number
): Promise<Prisma.Decimal> {
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const periodEnd = new Date(Date.UTC(periodYear, periodMonth, 1)); // exclusive, next month's 1st

  const records = await prisma.attendance_records.findMany({
    where: { business_id: businessId, employee_id: employeeId, status: "approved", work_date: { gte: periodStart, lt: periodEnd } },
    include: { attendance_adjustments: true },
  });

  let total = new Prisma.Decimal(0);
  for (const record of records) {
    const effective = record.attendance_adjustments.reduce((sum, a) => sum.plus(a.delta_hours), record.hours_worked);
    total = total.plus(effective);
  }
  return total;
}

export interface DayHours {
  workDate: Date;
  hours: Prisma.Decimal;
}

// Module 12 Session D -- FIXED_PLUS_TIME's own per-day overtime threshold
// needs a per-day breakdown, not a period total. Additive, alongside the
// existing getApprovedHoursForPeriod above (NOT modified -- HOURLY's
// already-shipped calculation path is untouched, confirmed Phase 0). Same
// query, same effective-hours-per-record computation (hours_worked + its
// own adjustments' deltas) -- just returned per-day instead of reduced to
// one sum.
export async function getApprovedHoursByDayForPeriod(
  businessId: string,
  employeeId: string,
  periodYear: number,
  periodMonth: number
): Promise<DayHours[]> {
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const periodEnd = new Date(Date.UTC(periodYear, periodMonth, 1)); // exclusive, next month's 1st

  const records = await prisma.attendance_records.findMany({
    where: { business_id: businessId, employee_id: employeeId, status: "approved", work_date: { gte: periodStart, lt: periodEnd } },
    include: { attendance_adjustments: true },
    orderBy: { work_date: "asc" },
  });

  return records.map((record) => ({
    workDate: record.work_date,
    hours: record.attendance_adjustments.reduce((sum, a) => sum.plus(a.delta_hours), record.hours_worked),
  }));
}
