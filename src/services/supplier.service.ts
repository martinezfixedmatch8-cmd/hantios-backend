import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest, conflict } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { domainEvents } from "../lib/events";
import type {
  CreateSupplierInput,
  UpdateSupplierInput,
  ListSuppliersQuery,
  ArchiveSupplierInput,
  RestoreSupplierInput,
} from "../validation/supplier.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_SUPPLIER_ENDPOINT = "POST /suppliers";
export const archiveSupplierEndpoint = (id: string): string => `POST /suppliers/${id}/archive`;

// Module 11 (Purchase Orders) prerequisite -- a full module (not a bare
// table), built this session per explicit decision. Materially simpler than
// Customer Records: no phone normalization, no find-or-create, no timeline,
// no search ranking, no uniqueness constraint on phone/name (nothing in the
// spec asked for supplier dedup, unlike Customers' phone-uniqueness rule).

export async function createSupplier(input: CreateSupplierInput, actor: Actor, idempotencyKey: string) {
  const supplier = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_SUPPLIER_ENDPOINT);

    const created = await tx.suppliers.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        name: input.name,
        phone: input.phone,
        email: input.email,
        notes: input.notes,
        status: "active",
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "supplier.created",
      entityType: "supplier",
      entityId: created.id,
      reason: `Supplier "${created.name}" added`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_SUPPLIER_ENDPOINT, 201, responseBody);

    return created;
  });

  domainEvents.publish("SupplierCreated", {
    businessId: actor.businessId,
    supplierId: supplier.id,
    name: supplier.name,
    occurredAt: supplier.created_at.toISOString(),
  });

  return supplier;
}

export async function listSuppliers(query: ListSuppliersQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at"] as const,
    defaultSort: "name" as const,
    searchableFields: ["name", "phone", "email"],
  });

  const where = {
    business_id: businessId,
    ...(query.status ? { status: query.status } : {}),
    ...(resolved.searchWhere ?? {}),
  };

  const [rows, total] = await Promise.all([
    prisma.suppliers.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.suppliers.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

export async function getSupplier(id: string, businessId: string) {
  return getOwned(prisma.suppliers.findUnique({ where: { id } }), businessId, "Supplier");
}

export async function updateSupplier(id: string, input: UpdateSupplierInput, actor: Actor) {
  const supplier = await getOwned(prisma.suppliers.findUnique({ where: { id } }), actor.businessId, "Supplier");

  const updated = await prisma.$transaction(async (tx) => {
    const updateResult = await tx.suppliers.updateMany({
      where: { id, business_id: actor.businessId, version: input.version },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        version: { increment: 1 },
      },
    });
    if (updateResult.count === 0) {
      throw conflict("Supplier was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "supplier.updated",
      entityType: "supplier",
      entityId: id,
      reason: `Supplier "${supplier.name}" updated`,
    });

    return tx.suppliers.findUniqueOrThrow({ where: { id } });
  });

  domainEvents.publish("SupplierUpdated", {
    businessId: actor.businessId,
    supplierId: updated.id,
    name: updated.name,
    occurredAt: updated.updated_at.toISOString(),
  });

  return updated;
}

export async function archiveSupplier(id: string, input: ArchiveSupplierInput, actor: Actor, idempotencyKey: string) {
  const supplier = await getOwned(prisma.suppliers.findUnique({ where: { id } }), actor.businessId, "Supplier");
  if (supplier.status === "archived") throw badRequest("Supplier is already archived");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveSupplierEndpoint(id));

    const updateResult = await tx.suppliers.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "active" },
      data: { status: "archived", archived_reason: input.reason, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Supplier was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "supplier.archived",
      entityType: "supplier",
      entityId: id,
      reason: input.reason,
    });

    const updated = await tx.suppliers.findUniqueOrThrow({ where: { id } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveSupplierEndpoint(id), 200, responseBody);
    return updated;
  });

  domainEvents.publish("SupplierArchived", {
    businessId: actor.businessId,
    supplierId: result.id,
    name: result.name,
    occurredAt: new Date().toISOString(),
  });

  return result;
}

// No Idempotency-Key (matches Customers' restore precedent) -- version-
// guarded, safe without one.
export async function restoreSupplier(id: string, input: RestoreSupplierInput, actor: Actor) {
  const supplier = await getOwned(prisma.suppliers.findUnique({ where: { id } }), actor.businessId, "Supplier");
  if (supplier.status === "active") throw badRequest("Supplier is not archived");

  const updateResult = await prisma.suppliers.updateMany({
    where: { id, business_id: actor.businessId, version: input.version, status: "archived" },
    data: { status: "active", archived_reason: null, version: { increment: 1 } },
  });
  if (updateResult.count === 0) {
    throw conflict("Supplier was modified concurrently, please retry with the latest version");
  }

  const updated = await prisma.suppliers.findUniqueOrThrow({ where: { id } });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "supplier.restored",
    entityType: "supplier",
    entityId: id,
    reason: `Supplier "${updated.name}" restored`,
  });

  return updated;
}
