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
  CreateDepartmentInput,
  UpdateDepartmentInput,
  ArchiveDepartmentInput,
  RestoreDepartmentInput,
  ListDepartmentsQuery,
} from "../validation/department.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_DEPARTMENT_ENDPOINT = "POST /departments";
export const archiveDepartmentEndpoint = (id: string): string => `POST /departments/${id}/archive`;
export const restoreDepartmentEndpoint = (id: string): string => `POST /departments/${id}/restore`;

function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Early usability check only -- the active-only partial unique index
// (ux_departments_business_id_active_name) is the real, final concurrency
// guarantee; a genuine race still reaches it and is converted from a raw
// P2002 to a clean 409 at every call site below.
async function assertNoActiveNameCollision(businessId: string, name: string, excludeId?: string): Promise<void> {
  const normalized = normalizeMasterDataName(name);
  const activeRows = await prisma.departments.findMany({
    where: { business_id: businessId, status: "active", ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, name: true },
  });
  if (activeRows.some((r) => normalizeMasterDataName(r.name) === normalized)) {
    throw badRequest(`A department named "${name}" already exists`);
  }
}

// Module 12 Session A -- plain, business-managed reference data, mirroring
// categories.service.ts's own minimal shape.
// Batch 6 (HNT2-HR-001) -- extended with the full lifecycle: create now
// requires Idempotency-Key (Option A) and checks the active-only
// normalized name collision; a genuine race against the partial unique
// index is converted from P2002 to a clean 409.
export async function createDepartment(input: CreateDepartmentInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_DEPARTMENT_ENDPOINT);
    await assertNoActiveNameCollision(actor.businessId, input.name);

    let department;
    try {
      department = await tx.departments.create({
        data: { id: generateId(), business_id: actor.businessId, name: input.name },
      });
    } catch (err) {
      if (isP2002(err)) throw conflict(`A department named "${input.name}" already exists`);
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "department.created",
      entityType: "department",
      entityId: department.id,
      reason: `Department "${department.name}" created`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: department })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_DEPARTMENT_ENDPOINT, 201, responseBody);
    return department;
  });
}

export async function listDepartments(query: ListDepartmentsQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at"] as const,
    defaultSort: "name",
    searchableFields: ["name"],
  });

  const where = {
    business_id: businessId,
    ...(query.status ? { status: query.status } : {}),
    ...(resolved.searchWhere ?? {}),
  };
  const [rows, total] = await Promise.all([
    prisma.departments.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.departments.count({ where }),
  ]);

  return paginate(rows, total, resolved.page, resolved.pageSize);
}

// Batch 6 (HNT2-HR-001) -- tenant-safe single-record read, new this batch.
export async function getDepartment(id: string, businessId: string) {
  return getOwned(prisma.departments.findUnique({ where: { id } }), businessId, "Department");
}

// Batch 6 (HNT2-HR-001) -- rename, version-guarded. No Idempotency-Key
// (matches this repo's own Customers/Suppliers precedent -- the version
// guard alone already makes a retry safe). Active-only name collision
// checked early (usability), then P2002-to-409 as the real backstop.
export async function updateDepartment(id: string, input: UpdateDepartmentInput, actor: Actor) {
  const department = await getOwned(prisma.departments.findUnique({ where: { id } }), actor.businessId, "Department");
  await assertNoActiveNameCollision(actor.businessId, input.name, id);

  let updated;
  try {
    const result = await prisma.departments.updateMany({
      where: { id, business_id: actor.businessId, version: input.version },
      data: { name: input.name, version: { increment: 1 } },
    });
    if (result.count === 0) throw conflict("Department was modified concurrently, please retry with the latest version");
    updated = await prisma.departments.findUniqueOrThrow({ where: { id } });
  } catch (err) {
    if (isP2002(err)) throw conflict(`A department named "${input.name}" already exists`);
    throw err;
  }

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "department.updated",
    entityType: "department",
    entityId: id,
    reason: `Department renamed to "${department.name}" -> "${updated.name}"`,
  });

  return updated;
}

// Batch 6 (HNT2-HR-001) -- archive, version-guarded + Idempotency-Key.
// Already-archived is treated as a successful no-op (state-based
// idempotency, independent of the Idempotency-Key mechanism) -- a plain
// 400/409 on a legitimate retry would be the exact bug class this batch's
// own review already caught and fixed for expense-category restore.
export async function archiveDepartment(id: string, input: ArchiveDepartmentInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveDepartmentEndpoint(id));

    const department = await getOwned(tx.departments.findUnique({ where: { id } }), actor.businessId, "Department");

    if (department.status === "archived") {
      const responseBody = JSON.parse(JSON.stringify({ data: department })) as unknown;
      await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveDepartmentEndpoint(id), 200, responseBody);
      return department;
    }

    const result = await tx.departments.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "active" },
      data: { status: "archived", version: { increment: 1 } },
    });
    if (result.count === 0) throw conflict("Department was modified concurrently, please retry with the latest version");
    const updated = await tx.departments.findUniqueOrThrow({ where: { id } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "department.archived",
      entityType: "department",
      entityId: id,
      reason: `Department "${department.name}" archived`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveDepartmentEndpoint(id), 200, responseBody);
    return updated;
  });
}

// Batch 6 (HNT2-HR-001) -- restore, version-guarded + Idempotency-Key.
// Already-active is a successful no-op. A genuine conflict (a different
// active department now holds the same normalized name) is converted from
// P2002 to a clean 409.
export async function restoreDepartment(id: string, input: RestoreDepartmentInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreDepartmentEndpoint(id));

    const department = await getOwned(tx.departments.findUnique({ where: { id } }), actor.businessId, "Department");

    if (department.status === "active") {
      const responseBody = JSON.parse(JSON.stringify({ data: department })) as unknown;
      await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreDepartmentEndpoint(id), 200, responseBody);
      return department;
    }

    let updated;
    try {
      const result = await tx.departments.updateMany({
        where: { id, business_id: actor.businessId, version: input.version, status: "archived" },
        data: { status: "active", version: { increment: 1 } },
      });
      if (result.count === 0) throw conflict("Department was modified concurrently, please retry with the latest version");
      updated = await tx.departments.findUniqueOrThrow({ where: { id } });
    } catch (err) {
      if (isP2002(err)) throw conflict(`Cannot restore -- an active department named "${department.name}" already exists`);
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "department.restored",
      entityType: "department",
      entityId: id,
      reason: `Department "${department.name}" restored`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreDepartmentEndpoint(id), 200, responseBody);
    return updated;
  });
}
