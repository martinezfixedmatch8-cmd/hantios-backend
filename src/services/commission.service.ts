import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { getReplayedResponse, claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import type { CreateCommissionAdjustmentInput } from "../validation/commission.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Confirmed Phase 0 (Q3/Q4) -- a plain Prisma fetch + JS Prisma.Decimal sum,
// not raw SQL, mirroring getApprovedHoursForPeriod's own shape and
// reasoning exactly: this is a small, single-employee/single-period
// aggregation, not a cross-employee list needing DB-side sorting (the one
// condition this repo's own convention reserves raw SQL for).
//
// status IN ('completed','refunded') -- excludes void and the dormant
// draft. This is what makes refund-netting fall out naturally: a refunded
// original row's own total is NEVER rewritten (Sale Refund's own Rule #3),
// and its reversal row (status "refunded" too, already-negated total, its
// own salesperson_employee_id copied forward from the original) is summed
// by ITS OWN real timestamp -- a same-period refund nets to zero
// automatically; a later-period refund correctly lands as a real, dated,
// negative entry in whichever period it actually happened, never touching
// the original period's own already-generated number.
export async function getEligibleSalesForPeriod(
  businessId: string,
  employeeId: string,
  periodYear: number,
  periodMonth: number
): Promise<Prisma.Decimal> {
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const periodEnd = new Date(Date.UTC(periodYear, periodMonth, 1)); // exclusive, next month's 1st

  const sales = await prisma.sales.findMany({
    where: {
      business_id: businessId,
      salesperson_employee_id: employeeId,
      status: { in: ["completed", "refunded"] },
      timestamp: { gte: periodStart, lt: periodEnd },
    },
  });

  return sales.reduce((sum, sale) => sum.plus(sale.total), new Prisma.Decimal(0));
}

export const CREATE_COMMISSION_ADJUSTMENT_ENDPOINT = "POST /commission-adjustments";

// Confirmed Phase 0 -- a manual, one-sided correction against an ALREADY-
// GENERATED payroll_records row (pending or paid; the property being
// protected is "already calculated," not specifically "already paid").
// Never mutates payroll_records.amount itself -- that stays permanently as
// originally calculated (Calculation Snapshot). Confirmed scope boundary:
// this is NOT an automated bilateral reallocation engine (it doesn't also
// auto-credit whoever the sale was reattributed to) -- that needs further,
// currently-unconfirmed business rules about timing/settlement. Recorded
// for audit/reconciliation; not automatically netted into any future
// payroll generation run this session.
export async function createCommissionAdjustment(input: CreateCommissionAdjustmentInput, actor: Actor, idempotencyKey: string) {
  const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, CREATE_COMMISSION_ADJUSTMENT_ENDPOINT);
  if (replayed) {
    return (replayed.body as { data: Awaited<ReturnType<typeof prisma.commission_adjustments.create>> }).data;
  }

  const employee = await getOwned(prisma.employees.findUnique({ where: { id: input.employeeId } }), actor.businessId, "Employee");
  const payrollRecord = await getOwned(
    prisma.payroll_records.findUnique({ where: { id: input.payrollRecordId } }),
    actor.businessId,
    "Payroll record"
  );
  if (payrollRecord.employee_id !== input.employeeId) {
    throw badRequest("This payroll record does not belong to the specified employee");
  }
  if (input.saleId) {
    await getOwned(prisma.sales.findUnique({ where: { id: input.saleId } }), actor.businessId, "Sale");
  }

  const adjustment = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_COMMISSION_ADJUSTMENT_ENDPOINT);

    const created = await tx.commission_adjustments.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        employee_id: input.employeeId,
        payroll_record_id: input.payrollRecordId,
        sale_id: input.saleId,
        delta_amount: new Prisma.Decimal(input.deltaAmount),
        reason: input.reason,
        created_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "commission_adjustment.created",
      entityType: "payroll_record",
      entityId: input.payrollRecordId,
      reason: `Commission adjustment for "${employee.name}": ${input.deltaAmount} (${input.reason})`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_COMMISSION_ADJUSTMENT_ENDPOINT, 201, responseBody);

    return created;
  });

  domainEvents.publish("CommissionAdjustmentCreated", {
    businessId: actor.businessId,
    commissionAdjustmentId: adjustment.id,
    employeeId: input.employeeId,
    payrollRecordId: input.payrollRecordId,
    deltaAmount: adjustment.delta_amount.toString(),
    occurredAt: adjustment.created_at.toISOString(),
  });

  return adjustment;
}
