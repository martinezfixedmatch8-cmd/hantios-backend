import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest, conflict } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { normalizeMasterDataName } from "../lib/masterDataName";
import type {
  CreatePositionInput,
  UpdatePositionInput,
  ArchivePositionInput,
  RestorePositionInput,
  ListPositionsQuery,
} from "../validation/position.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_POSITION_ENDPOINT = "POST /positions";
export const archivePositionEndpoint = (id: string): string => `POST /positions/${id}/archive`;
export const restorePositionEndpoint = (id: string): string => `POST /positions/${id}/restore`;

function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function assertNoActiveTitleCollision(businessId: string, title: string, excludeId?: string): Promise<void> {
  const normalized = normalizeMasterDataName(title);
  const activeRows = await prisma.positions.findMany({
    where: { business_id: businessId, status: "active", ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, title: true },
  });
  if (activeRows.some((r) => normalizeMasterDataName(r.title) === normalized)) {
    throw badRequest(`A position named "${title}" already exists`);
  }
}

// Batch 6 (HNT2-HR-001), item 5 -- a NEW or REASSIGNED departmentId must
// never attach to an archived department. Historical links are untouched
// by this check -- it only fires when departmentId is actually being set.
async function assertDepartmentActiveIfProvided(businessId: string, departmentId: string | null | undefined): Promise<void> {
  if (!departmentId) return;
  const department = await getOwned(prisma.departments.findUnique({ where: { id: departmentId } }), businessId, "Department");
  if (department.status !== "active") throw badRequest("Department is archived");
}

export async function createPosition(input: CreatePositionInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_POSITION_ENDPOINT);
    await assertDepartmentActiveIfProvided(actor.businessId, input.departmentId);
    await assertNoActiveTitleCollision(actor.businessId, input.title);

    let position;
    try {
      position = await tx.positions.create({
        data: { id: generateId(), business_id: actor.businessId, department_id: input.departmentId, title: input.title },
      });
    } catch (err) {
      if (isP2002(err)) throw conflict(`A position named "${input.title}" already exists`);
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "position.created",
      entityType: "position",
      entityId: position.id,
      reason: `Position "${position.title}" created`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: position })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_POSITION_ENDPOINT, 201, responseBody);
    return position;
  });
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
    ...(query.status ? { status: query.status } : {}),
    ...(resolved.searchWhere ?? {}),
  };
  const [rows, total] = await Promise.all([
    prisma.positions.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.positions.count({ where }),
  ]);

  return paginate(rows, total, resolved.page, resolved.pageSize);
}

export async function getPosition(id: string, businessId: string) {
  return getOwned(prisma.positions.findUnique({ where: { id } }), businessId, "Position");
}

export async function updatePosition(id: string, input: UpdatePositionInput, actor: Actor) {
  const position = await getOwned(prisma.positions.findUnique({ where: { id } }), actor.businessId, "Position");

  // Only checked when departmentId is actually present in the request
  // (assigning or reassigning) -- explicit null (clearing) or omission
  // (unchanged) never triggers this.
  if (input.departmentId) {
    await assertDepartmentActiveIfProvided(actor.businessId, input.departmentId);
  }
  await assertNoActiveTitleCollision(actor.businessId, input.title, id);

  let updated;
  try {
    const result = await prisma.positions.updateMany({
      where: { id, business_id: actor.businessId, version: input.version },
      data: {
        title: input.title,
        ...(input.departmentId !== undefined ? { department_id: input.departmentId } : {}),
        version: { increment: 1 },
      },
    });
    if (result.count === 0) throw conflict("Position was modified concurrently, please retry with the latest version");
    updated = await prisma.positions.findUniqueOrThrow({ where: { id } });
  } catch (err) {
    if (isP2002(err)) throw conflict(`A position named "${input.title}" already exists`);
    throw err;
  }

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "position.updated",
    entityType: "position",
    entityId: id,
    reason: `Position "${position.title}" updated`,
  });

  return updated;
}

export async function archivePosition(id: string, input: ArchivePositionInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, archivePositionEndpoint(id));

    const position = await getOwned(tx.positions.findUnique({ where: { id } }), actor.businessId, "Position");

    if (position.status === "archived") {
      const responseBody = JSON.parse(JSON.stringify({ data: position })) as unknown;
      await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archivePositionEndpoint(id), 200, responseBody);
      return position;
    }

    const result = await tx.positions.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "active" },
      data: { status: "archived", version: { increment: 1 } },
    });
    if (result.count === 0) throw conflict("Position was modified concurrently, please retry with the latest version");
    const updated = await tx.positions.findUniqueOrThrow({ where: { id } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "position.archived",
      entityType: "position",
      entityId: id,
      reason: `Position "${position.title}" archived`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archivePositionEndpoint(id), 200, responseBody);
    return updated;
  });
}

export async function restorePosition(id: string, input: RestorePositionInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, restorePositionEndpoint(id));

    const position = await getOwned(tx.positions.findUnique({ where: { id } }), actor.businessId, "Position");

    if (position.status === "active") {
      const responseBody = JSON.parse(JSON.stringify({ data: position })) as unknown;
      await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restorePositionEndpoint(id), 200, responseBody);
      return position;
    }

    let updated;
    try {
      const result = await tx.positions.updateMany({
        where: { id, business_id: actor.businessId, version: input.version, status: "archived" },
        data: { status: "active", version: { increment: 1 } },
      });
      if (result.count === 0) throw conflict("Position was modified concurrently, please retry with the latest version");
      updated = await tx.positions.findUniqueOrThrow({ where: { id } });
    } catch (err) {
      if (isP2002(err)) throw conflict(`Cannot restore -- an active position named "${position.title}" already exists`);
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "position.restored",
      entityType: "position",
      entityId: id,
      reason: `Position "${position.title}" restored`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restorePositionEndpoint(id), 200, responseBody);
    return updated;
  });
}
