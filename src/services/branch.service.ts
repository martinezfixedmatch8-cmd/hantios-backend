import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { conflict } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import type { CreateBranchInput, UpdateBranchInput, ArchiveBranchInput, RestoreBranchInput, ListBranchesQuery } from "../validation/branch.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_BRANCH_ENDPOINT = "POST /branches";
export const archiveBranchEndpoint = (id: string): string => `POST /branches/${id}/archive`;
export const restoreBranchEndpoint = (id: string): string => `POST /branches/${id}/restore`;

async function assertManagerBelongsToBusiness(managerId: string, businessId: string): Promise<void> {
  await getOwned(prisma.users.findUnique({ where: { id: managerId } }), businessId, "Manager");
}

// Batch 6 (HNT2-MD-001) -- create now requires Idempotency-Key (Option A).
export async function createBranch(input: CreateBranchInput, actor: Actor, idempotencyKey: string) {
  if (input.managerId) {
    await assertManagerBelongsToBusiness(input.managerId, actor.businessId);
  }

  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_BRANCH_ENDPOINT);

    const branch = await tx.branches.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        name: input.name,
        location: input.location,
        manager_id: input.managerId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "branch.created",
      entityType: "branch",
      entityId: branch.id,
      reason: `Branch "${branch.name}" created`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: branch })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_BRANCH_ENDPOINT, 201, responseBody);
    return branch;
  });
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

// Batch 6 (HNT2-MD-001) -- version-guarded atomic update, replacing the
// prior plain (non-atomic) update. No Idempotency-Key (version guard alone
// is sufficient for PATCH, per the confirmed policy table).
export async function updateBranch(id: string, input: UpdateBranchInput, actor: Actor) {
  await getOwned(prisma.branches.findUnique({ where: { id } }), actor.businessId, "Branch");

  if (input.managerId) {
    await assertManagerBelongsToBusiness(input.managerId, actor.businessId);
  }

  const result = await prisma.branches.updateMany({
    where: { id, business_id: actor.businessId, version: input.version },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.managerId !== undefined ? { manager_id: input.managerId } : {}),
      version: { increment: 1 },
    },
  });
  if (result.count === 0) throw conflict("Branch was modified concurrently, please retry with the latest version");
  const updated = await prisma.branches.findUniqueOrThrow({ where: { id } });

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

// Batch 6 (HNT2-MD-001) -- version-guarded + Idempotency-Key. Already-
// archived is a successful no-op, not an error.
export async function archiveBranch(id: string, input: ArchiveBranchInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveBranchEndpoint(id));

    const branch = await getOwned(tx.branches.findUnique({ where: { id } }), actor.businessId, "Branch");

    if (branch.status === "archived") {
      const responseBody = JSON.parse(JSON.stringify({ data: branch })) as unknown;
      await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveBranchEndpoint(id), 200, responseBody);
      return branch;
    }

    const result = await tx.branches.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "active" },
      data: { status: "archived", version: { increment: 1 } },
    });
    if (result.count === 0) throw conflict("Branch was modified concurrently, please retry with the latest version");
    const updated = await tx.branches.findUniqueOrThrow({ where: { id } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "branch.archived",
      entityType: "branch",
      entityId: id,
      reason: `Branch "${branch.name}" archived`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveBranchEndpoint(id), 200, responseBody);
    return updated;
  });
}

export async function restoreBranch(id: string, input: RestoreBranchInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreBranchEndpoint(id));

    const branch = await getOwned(tx.branches.findUnique({ where: { id } }), actor.businessId, "Branch");

    if (branch.status === "active") {
      const responseBody = JSON.parse(JSON.stringify({ data: branch })) as unknown;
      await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreBranchEndpoint(id), 200, responseBody);
      return branch;
    }

    const result = await tx.branches.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "archived" },
      data: { status: "active", version: { increment: 1 } },
    });
    if (result.count === 0) throw conflict("Branch was modified concurrently, please retry with the latest version");
    const updated = await tx.branches.findUniqueOrThrow({ where: { id } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "branch.restored",
      entityType: "branch",
      entityId: id,
      reason: `Branch "${branch.name}" restored`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreBranchEndpoint(id), 200, responseBody);
    return updated;
  });
}
