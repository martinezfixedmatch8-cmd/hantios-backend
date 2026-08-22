import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { paginate, resolveListQuery } from "../lib/pagination";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import type { CreateTagInput, UpdateTagInput, ArchiveTagInput, RestoreTagInput, ListTagsQuery } from "../validation/tag.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_TAG_ENDPOINT = "POST /tags";
export const archiveTagEndpoint = (id: string): string => `POST /tags/${id}/archive`;
export const restoreTagEndpoint = (id: string): string => `POST /tags/${id}/restore`;

function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Batch 6 (HNT2-MASTER-001) -- create now requires Idempotency-Key
// (Option A). The existing name pre-check stays (harmless, now backed by
// a real active-only partial unique index too); P2002 added as the real
// concurrency backstop.
export async function createTag(input: CreateTagInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_TAG_ENDPOINT);

    const existing = await tx.tags.findFirst({
      where: { business_id: actor.businessId, name: input.name, status: "active" },
    });
    if (existing) throw badRequest(`A tag named "${input.name}" already exists`);

    let tag;
    try {
      tag = await tx.tags.create({ data: { id: generateId(), business_id: actor.businessId, name: input.name } });
    } catch (err) {
      if (isP2002(err)) throw conflict(`A tag named "${input.name}" already exists`);
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "tag.created",
      entityType: "tag",
      entityId: tag.id,
      reason: `Tag "${tag.name}" created`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: tag })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_TAG_ENDPOINT, 201, responseBody);
    return tag;
  });
}

export async function listTags(query: ListTagsQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at"] as const,
    defaultSort: "name" as const,
    searchableFields: ["name"],
  });

  const where: Prisma.tagsWhereInput = {
    business_id: businessId,
    ...(query.status ? { status: query.status } : {}),
    ...(resolved.searchWhere ?? {}),
  };

  const [rows, total] = await Promise.all([
    prisma.tags.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.tags.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

// Batch 6 (HNT2-MASTER-001) -- new tenant-safe single-record read.
export async function getTag(id: string, businessId: string) {
  return getOwned(prisma.tags.findUnique({ where: { id } }), businessId, "Tag");
}

// Batch 6 (HNT2-MASTER-001) -- rename, version-guarded, no Idempotency-Key.
// Exact-match name comparison, matching the existing create precheck.
export async function updateTag(id: string, input: UpdateTagInput, actor: Actor) {
  const tag = await getOwned(prisma.tags.findUnique({ where: { id } }), actor.businessId, "Tag");

  const existing = await prisma.tags.findFirst({
    where: { business_id: actor.businessId, name: input.name, status: "active", id: { not: id } },
  });
  if (existing) throw badRequest(`A tag named "${input.name}" already exists`);

  let updated;
  try {
    const result = await prisma.tags.updateMany({
      where: { id, business_id: actor.businessId, version: input.version },
      data: { name: input.name, version: { increment: 1 } },
    });
    if (result.count === 0) throw conflict("Tag was modified concurrently, please retry with the latest version");
    updated = await prisma.tags.findUniqueOrThrow({ where: { id } });
  } catch (err) {
    if (isP2002(err)) throw conflict(`A tag named "${input.name}" already exists`);
    throw err;
  }

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "tag.updated",
    entityType: "tag",
    entityId: id,
    reason: `Tag "${tag.name}" renamed to "${updated.name}"`,
  });

  return updated;
}

export async function archiveTag(id: string, input: ArchiveTagInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveTagEndpoint(id));

    const tag = await getOwned(tx.tags.findUnique({ where: { id } }), actor.businessId, "Tag");

    if (tag.status === "archived") {
      const responseBody = JSON.parse(JSON.stringify({ data: tag })) as unknown;
      await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveTagEndpoint(id), 200, responseBody);
      return tag;
    }

    const result = await tx.tags.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "active" },
      data: { status: "archived", version: { increment: 1 } },
    });
    if (result.count === 0) throw conflict("Tag was modified concurrently, please retry with the latest version");
    const updated = await tx.tags.findUniqueOrThrow({ where: { id } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "tag.archived",
      entityType: "tag",
      entityId: id,
      reason: `Tag "${tag.name}" archived`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveTagEndpoint(id), 200, responseBody);
    return updated;
  });
}

// Restoring can now genuinely conflict with a different active tag that
// reused this name while the original was archived (HNT2-MASTER-001's own
// active-only-reuse decision) -- P2002 converts that race to a clean 409.
export async function restoreTag(id: string, input: RestoreTagInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreTagEndpoint(id));

    const tag = await getOwned(tx.tags.findUnique({ where: { id } }), actor.businessId, "Tag");

    if (tag.status === "active") {
      const responseBody = JSON.parse(JSON.stringify({ data: tag })) as unknown;
      await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreTagEndpoint(id), 200, responseBody);
      return tag;
    }

    let updated;
    try {
      const result = await tx.tags.updateMany({
        where: { id, business_id: actor.businessId, version: input.version, status: "archived" },
        data: { status: "active", version: { increment: 1 } },
      });
      if (result.count === 0) throw conflict("Tag was modified concurrently, please retry with the latest version");
      updated = await tx.tags.findUniqueOrThrow({ where: { id } });
    } catch (err) {
      if (isP2002(err)) throw conflict(`Cannot restore -- an active tag named "${tag.name}" already exists`);
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "tag.restored",
      entityType: "tag",
      entityId: id,
      reason: `Tag "${tag.name}" restored`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreTagEndpoint(id), 200, responseBody);
    return updated;
  });
}
