import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import type { CreateDepartmentInput, ListDepartmentsQuery } from "../validation/department.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Module 12 Session A -- plain, business-managed reference data, mirroring
// categories.service.ts's own minimal shape. No update/archive this
// session ("no department-management UI workflow" per the confirmed
// addendum) -- create + list only.
export async function createDepartment(input: CreateDepartmentInput, actor: Actor) {
  const department = await prisma.departments.create({
    data: { id: generateId(), business_id: actor.businessId, name: input.name },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "department.created",
    entityType: "department",
    entityId: department.id,
    reason: `Department "${department.name}" created`,
  });

  return department;
}

export async function listDepartments(query: ListDepartmentsQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at"] as const,
    defaultSort: "name",
    searchableFields: ["name"],
  });

  const where = { business_id: businessId, ...(resolved.searchWhere ?? {}) };
  const [rows, total] = await Promise.all([
    prisma.departments.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.departments.count({ where }),
  ]);

  return paginate(rows, total, resolved.page, resolved.pageSize);
}
