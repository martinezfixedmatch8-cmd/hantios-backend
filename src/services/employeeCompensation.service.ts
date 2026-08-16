import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { getCurrency } from "../lib/currencyReference";
import type { CreateEmployeeCompensationInput } from "../validation/compensation.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Module 12 Session A -- effective-dated compensation structure, the
// Policy Snapshot foundation everything else in this module builds on.
// Creating a new row atomically closes out whatever was previously the
// CURRENT one (effective_to: null) for this employee, so the timeline
// never has two simultaneously-active structures. currency_code is
// snapshotted from Business.currency at THIS moment -- never re-derived
// later, even if the business's own default currency changes afterward.
export async function createEmployeeCompensation(employeeId: string, input: CreateEmployeeCompensationInput, actor: Actor) {
  const employee = await getOwned(prisma.employees.findUnique({ where: { id: employeeId } }), actor.businessId, "Employee");
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  const currency = getCurrency(business.currency);

  const created = await prisma.$transaction(async (tx) => {
    // HNT-PAY-002 fix -- find-close-create used to be three separate
    // statements with no lock, so two concurrent calls could both read the
    // same "current" row before either closed it, producing two
    // simultaneously-open compensation rows for one employee. Fixed with a
    // real Postgres row lock (not the advisory-lock approach already tried
    // and abandoned elsewhere in this repo, Module 11 Session B) on the
    // employee's own row -- a real row that always exists, unlike "the
    // current compensation row" which doesn't exist yet for a brand-new
    // employee's first-ever compensation structure. This serializes any
    // two concurrent compensation-timeline operations for the SAME
    // employee. The real backstop is the partial unique index added in
    // this same migration (ux_employee_compensation_one_current) -- this
    // lock is what lets the read-close-create sequence below observe truly
    // committed state, the index is what makes a violation structurally
    // impossible even if a future code path ever bypassed this lock.
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employeeId} FOR UPDATE`;

    const current = await tx.employee_compensation.findFirst({
      where: { business_id: actor.businessId, employee_id: employeeId, effective_to: null },
      orderBy: { effective_from: "desc" },
    });

    if (current && current.effective_from >= input.effectiveFrom) {
      throw badRequest("effectiveFrom must be after the currently active compensation structure's own effective_from");
    }

    if (current) {
      await tx.employee_compensation.update({
        where: { id: current.id },
        data: { effective_to: input.effectiveFrom },
      });
    }

    let row;
    try {
      row = await tx.employee_compensation.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          employee_id: employeeId,
          compensation_model: input.compensationModel,
          effective_from: input.effectiveFrom,
          effective_to: null,
          currency_code: currency?.code ?? business.currency,
          compensation_config: input.config,
          created_by: actor.userId,
        },
      });
    } catch (err) {
      // Defense-in-depth -- the row lock above should make this
      // unreachable in normal operation, but ux_employee_compensation_one_current
      // is the real, structural guarantee: if it's ever violated regardless,
      // surface a clean 409, not a raw 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw conflict("This employee already has a currently-active compensation structure; retry the request");
      }
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "employee_compensation.created",
      entityType: "employee_compensation",
      entityId: row.id,
      reason: `Compensation structure set for "${employee.name}" (${input.compensationModel}), effective ${input.effectiveFrom.toISOString().slice(0, 10)}`,
    });

    return row;
  });

  domainEvents.publish("EmployeeCompensationCreated", {
    businessId: actor.businessId,
    employeeId,
    compensationId: created.id,
    compensationModel: created.compensation_model,
  });

  return created;
}

export async function listEmployeeCompensation(employeeId: string, businessId: string) {
  await getOwned(prisma.employees.findUnique({ where: { id: employeeId } }), businessId, "Employee");
  return prisma.employee_compensation.findMany({
    where: { business_id: businessId, employee_id: employeeId },
    orderBy: { effective_from: "desc" },
  });
}

// The single lookup used by payroll generation -- whichever structure was
// effective for the exact calendar date given (a payroll period's own
// first day). Never called at any other time; a later compensation change
// must never retroactively alter an already-generated payroll record.
export async function findEffectiveCompensation(businessId: string, employeeId: string, forDate: Date) {
  return prisma.employee_compensation.findFirst({
    where: {
      business_id: businessId,
      employee_id: employeeId,
      effective_from: { lte: forDate },
      OR: [{ effective_to: null }, { effective_to: { gt: forDate } }],
    },
    orderBy: { effective_from: "desc" },
  });
}
