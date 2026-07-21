import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest } from "../lib/errors";
import type { CreateBranchInput, UpdateBranchInput, ListBranchesQuery } from "../validation/branch.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

async function assertManagerBelongsToBusiness(managerId: string, businessId: string): Promise<void> {
  await getOwned(prisma.users.findUnique({ where: { id: managerId } }), businessId, "Manager");
}

export async function createBranch(input: CreateBranchInput, actor: Actor) {
  if (input.managerId) {
    await assertManagerBelongsToBusiness(input.managerId, actor.businessId);
  }

  const branch = await prisma.branches.create({
    data: {
      id: generateId(),
      business_id: actor.businessId,
      name: input.name,
      location: input.location,
      manager_id: input.managerId,
    },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "branch.created",
    entityType: "branch",
    entityId: branch.id,
    reason: `Branch "${branch.name}" created`,
  });

  return branch;
}

export async function listBranches(query: ListBranchesQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at"] as const,
    defaultSort: "created_at",
    searchableFields: ["name", "location"],
  });

  const where = {
    business_id: businessId,
    ...(query.status ? { status: query.status } : {}),
    ...resolved.searchWhere,
  };

  const [rows, total] = await Promise.all([
    prisma.branches.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.branches.count({ where }),
  ]);

  return paginate(rows, total, resolved.page, resolved.pageSize);
}

export async function getBranch(id: string, businessId: string) {
  return getOwned(prisma.branches.findUnique({ where: { id } }), businessId, "Branch");
}

export async function updateBranch(id: string, input: UpdateBranchInput, actor: Actor) {
  await getOwned(prisma.branches.findUnique({ where: { id } }), actor.businessId, "Branch");

  if (input.managerId) {
    await assertManagerBelongsToBusiness(input.managerId, actor.businessId);
  }

  const updated = await prisma.branches.update({
    where: { id },
    data: {
      name: input.name,
      location: input.location,
      manager_id: input.managerId,
    },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "branch.updated",
    entityType: "branch",
    entityId: id,
    reason: `Branch "${updated.name}" updated`,
  });

  return updated;
}

export async function archiveBranch(id: string, actor: Actor) {
  const branch = await getOwned(prisma.branches.findUnique({ where: { id } }), actor.businessId, "Branch");
  if (branch.status === "archived") {
    throw badRequest("Branch is already archived");
  }

  const updated = await prisma.branches.update({ where: { id }, data: { status: "archived" } });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "branch.archived",
    entityType: "branch",
    entityId: id,
    reason: `Branch "${branch.name}" archived`,
  });

  return updated;
}

export async function restoreBranch(id: string, actor: Actor) {
  const branch = await getOwned(prisma.branches.findUnique({ where: { id } }), actor.businessId, "Branch");
  if (branch.status === "active") {
    throw badRequest("Branch is not archived");
  }

  const updated = await prisma.branches.update({ where: { id }, data: { status: "active" } });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "branch.restored",
    entityType: "branch",
    entityId: id,
    reason: `Branch "${branch.name}" restored`,
  });

  return updated;
}
