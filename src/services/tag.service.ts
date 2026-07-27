import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { badRequest } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { paginate, resolveListQuery } from "../lib/pagination";
import type { CreateTagInput, ListTagsQuery } from "../validation/tag.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export async function createTag(input: CreateTagInput, actor: Actor) {
  const existing = await prisma.tags.findUnique({
    where: { business_id_name: { business_id: actor.businessId, name: input.name } },
  });
  if (existing) throw badRequest(`A tag named "${input.name}" already exists`);

  const tag = await prisma.tags.create({
    data: { id: generateId(), business_id: actor.businessId, name: input.name },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "tag.created",
    entityType: "tag",
    entityId: tag.id,
    reason: `Tag "${tag.name}" created`,
  });

  return tag;
}

export async function listTags(query: ListTagsQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at"] as const,
    defaultSort: "name" as const,
    searchableFields: ["name"],
  });

  const where: Prisma.tagsWhereInput = { business_id: businessId, ...(resolved.searchWhere ?? {}) };

  const [rows, total] = await Promise.all([
    prisma.tags.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.tags.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}
