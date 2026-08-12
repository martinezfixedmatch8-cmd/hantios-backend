import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest, conflict } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { domainEvents } from "../lib/events";
import type {
  CreateEmployeeInput,
  UpdateEmployeeInput,
  ListEmployeesQuery,
  ArchiveEmployeeInput,
  RestoreEmployeeInput,
} from "../validation/employee.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_EMPLOYEE_ENDPOINT = "POST /employees";
export const archiveEmployeeEndpoint = (id: string): string => `POST /employees/${id}/archive`;

// Module 12 Session A. A genuinely separate concept from users -- see the
// employees model's own schema comment. Idempotency-Key on create/archive
// is an inferred addition (not explicitly named in the locked spec, which
// only names mark-as-paid/bulk-pay) -- matches Suppliers'/Customers' own
// precedent for financial-adjacent records, since a duplicate Employee row
// could seed duplicate future payroll.
export async function createEmployee(input: CreateEmployeeInput, actor: Actor, idempotencyKey: string) {
  if (input.branchId) {
    await getOwned(prisma.branches.findUnique({ where: { id: input.branchId } }), actor.businessId, "Branch");
  }
  if (input.departmentId) {
    await getOwned(prisma.departments.findUnique({ where: { id: input.departmentId } }), actor.businessId, "Department");
  }
  if (input.positionId) {
    await getOwned(prisma.positions.findUnique({ where: { id: input.positionId } }), actor.businessId, "Position");
  }
  if (input.userId) {
    await getOwned(prisma.users.findUnique({ where: { id: input.userId } }), actor.businessId, "User");
  }

  const employee = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_EMPLOYEE_ENDPOINT);

    let created;
    try {
      created = await tx.employees.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          name: input.name,
          phone: input.phone,
          branch_id: input.branchId,
          department_id: input.departmentId,
          position_id: input.positionId,
          user_id: input.userId,
          status: "active",
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw conflict("This user is already linked to another employee record");
      }
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "employee.created",
      entityType: "employee",
      entityId: created.id,
      reason: `Employee "${created.name}" added`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_EMPLOYEE_ENDPOINT, 201, responseBody);

    return created;
  });

  domainEvents.publish("EmployeeCreated", {
    businessId: actor.businessId,
    employeeId: employee.id,
    name: employee.name,
    occurredAt: employee.created_at.toISOString(),
  });

  return employee;
}

export async function listEmployees(query: ListEmployeesQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at"] as const,
    defaultSort: "name" as const,
    searchableFields: ["name", "phone"],
  });

  const where = {
    business_id: businessId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.branchId ? { branch_id: query.branchId } : {}),
    ...(query.departmentId ? { department_id: query.departmentId } : {}),
    ...(resolved.searchWhere ?? {}),
  };

  const [rows, total] = await Promise.all([
    prisma.employees.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.employees.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

export async function getEmployee(id: string, businessId: string) {
  return getOwned(prisma.employees.findUnique({ where: { id } }), businessId, "Employee");
}

export async function updateEmployee(id: string, input: UpdateEmployeeInput, actor: Actor) {
  const employee = await getOwned(prisma.employees.findUnique({ where: { id } }), actor.businessId, "Employee");

  if (input.branchId) {
    await getOwned(prisma.branches.findUnique({ where: { id: input.branchId } }), actor.businessId, "Branch");
  }
  if (input.departmentId) {
    await getOwned(prisma.departments.findUnique({ where: { id: input.departmentId } }), actor.businessId, "Department");
  }
  if (input.positionId) {
    await getOwned(prisma.positions.findUnique({ where: { id: input.positionId } }), actor.businessId, "Position");
  }
  if (input.userId) {
    await getOwned(prisma.users.findUnique({ where: { id: input.userId } }), actor.businessId, "User");
  }

  const updated = await prisma.$transaction(async (tx) => {
    let updateResult;
    try {
      updateResult = await tx.employees.updateMany({
        where: { id, business_id: actor.businessId, version: input.version },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.branchId !== undefined ? { branch_id: input.branchId } : {}),
          ...(input.departmentId !== undefined ? { department_id: input.departmentId } : {}),
          ...(input.positionId !== undefined ? { position_id: input.positionId } : {}),
          ...(input.userId !== undefined ? { user_id: input.userId } : {}),
          version: { increment: 1 },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw conflict("This user is already linked to another employee record");
      }
      throw err;
    }
    if (updateResult.count === 0) {
      throw conflict("Employee was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "employee.updated",
      entityType: "employee",
      entityId: id,
      reason: `Employee "${employee.name}" updated`,
    });

    return tx.employees.findUniqueOrThrow({ where: { id } });
  });

  domainEvents.publish("EmployeeUpdated", {
    businessId: actor.businessId,
    employeeId: updated.id,
    name: updated.name,
    occurredAt: updated.updated_at.toISOString(),
  });

  return updated;
}

// Archiving excludes the employee from future monthly payroll generation
// (see payroll.service.ts's own generator, which only considers
// status:"active" employees) -- already-generated payroll records are
// untouched, permanent history either way.
export async function archiveEmployee(id: string, input: ArchiveEmployeeInput, actor: Actor, idempotencyKey: string) {
  const employee = await getOwned(prisma.employees.findUnique({ where: { id } }), actor.businessId, "Employee");
  if (employee.status === "archived") throw badRequest("Employee is already archived");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveEmployeeEndpoint(id));

    const updateResult = await tx.employees.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "active" },
      data: { status: "archived", version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Employee was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "employee.archived",
      entityType: "employee",
      entityId: id,
      reason: input.reason,
    });

    const updated = await tx.employees.findUniqueOrThrow({ where: { id } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveEmployeeEndpoint(id), 200, responseBody);
    return updated;
  });

  domainEvents.publish("EmployeeArchived", {
    businessId: actor.businessId,
    employeeId: result.id,
    name: result.name,
    occurredAt: new Date().toISOString(),
  });

  return result;
}

// No Idempotency-Key -- version-guarded, safe without one, matches
// Suppliers'/Customers' own restore precedent.
export async function restoreEmployee(id: string, input: RestoreEmployeeInput, actor: Actor) {
  const employee = await getOwned(prisma.employees.findUnique({ where: { id } }), actor.businessId, "Employee");
  if (employee.status === "active") throw badRequest("Employee is not archived");

  const updateResult = await prisma.employees.updateMany({
    where: { id, business_id: actor.businessId, version: input.version, status: "archived" },
    data: { status: "active", version: { increment: 1 } },
  });
  if (updateResult.count === 0) {
    throw conflict("Employee was modified concurrently, please retry with the latest version");
  }

  const updated = await prisma.employees.findUniqueOrThrow({ where: { id } });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "employee.restored",
    entityType: "employee",
    entityId: id,
    reason: `Employee "${updated.name}" restored`,
  });

  return updated;
}
