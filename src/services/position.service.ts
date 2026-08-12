import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import type { CreatePositionInput, ListPositionsQuery } from "../validation/position.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export async function createPosition(input: CreatePositionInput, actor: Actor) {
  if (input.departmentId) {
    await getOwned(prisma.departments.findUnique({ where: { id: input.departmentId } }), actor.businessId, "Department");
  }

  const position = await prisma.positions.create({
    data: { id: generateId(), business_id: actor.businessId, department_id: input.departmentId, title: input.title },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "position.created",
    entityType: "position",
    entityId: position.id,
    reason: `Position "${position.title}" created`,
  });

  return position;
}

export async function listPositions(query: ListPositionsQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["title", "created_at"] as const,
    defaultSort: "title",
    searchableFields: ["title"],
  });

  const where = {
    business_id: businessId,
    ...(query.departmentId ? { department_id: query.departmentId } : {}),
    ...(resolved.searchWhere ?? {}),
  };
  const [rows, total] = await Promise.all([
    prisma.positions.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.positions.count({ where }),
  ]);

  return paginate(rows, total, resolved.page, resolved.pageSize);
}
