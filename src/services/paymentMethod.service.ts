import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { conflict } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import type {
  CreatePaymentMethodInput,
  UpdatePaymentMethodInput,
  ArchivePaymentMethodInput,
  RestorePaymentMethodInput,
  ListPaymentMethodsQuery,
} from "../validation/paymentMethod.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_PAYMENT_METHOD_ENDPOINT = "POST /payment-methods";
export const archivePaymentMethodEndpoint = (id: string): string => `POST /payment-methods/${id}/archive`;
export const restorePaymentMethodEndpoint = (id: string): string => `POST /payment-methods/${id}/restore`;

// Batch 6 (HNT2-MD-001) -- create now requires Idempotency-Key (Option A).
export async function createPaymentMethod(input: CreatePaymentMethodInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_PAYMENT_METHOD_ENDPOINT);

    const paymentMethod = await tx.payment_methods.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        name: input.name,
        logo_url: input.logoUrl,
        account_number: input.accountNumber,
        description: input.description,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "payment_method.created",
      entityType: "payment_method",
      entityId: paymentMethod.id,
      reason: `Payment method "${paymentMethod.name}" created`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: paymentMethod })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_PAYMENT_METHOD_ENDPOINT, 201, responseBody);
    return paymentMethod;
  });
}

export async function listPaymentMethods(query: ListPaymentMethodsQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at"] as const,
    defaultSort: "created_at",
    searchableFields: ["name", "account_number"],
  });

  const where = {
    business_id: businessId,
    ...(query.status ? { status: query.status } : {}),
    ...resolved.searchWhere,
  };

  const [rows, total] = await Promise.all([
    prisma.payment_methods.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.payment_methods.count({ where }),
  ]);

  return paginate(rows, total, resolved.page, resolved.pageSize);
}

export async function getPaymentMethod(id: string, businessId: string) {
  return getOwned(prisma.payment_methods.findUnique({ where: { id } }), businessId, "Payment method");
}

// Batch 6 (HNT2-MD-001) -- version-guarded atomic update.
export async function updatePaymentMethod(id: string, input: UpdatePaymentMethodInput, actor: Actor) {
  await getOwned(prisma.payment_methods.findUnique({ where: { id } }), actor.businessId, "Payment method");

  const result = await prisma.payment_methods.updateMany({
    where: { id, business_id: actor.businessId, version: input.version },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.logoUrl !== undefined ? { logo_url: input.logoUrl } : {}),
      ...(input.accountNumber !== undefined ? { account_number: input.accountNumber } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      version: { increment: 1 },
    },
  });
  if (result.count === 0) throw conflict("Payment method was modified concurrently, please retry with the latest version");
  const updated = await prisma.payment_methods.findUniqueOrThrow({ where: { id } });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "payment_method.updated",
    entityType: "payment_method",
    entityId: id,
    reason: `Payment method "${updated.name}" updated`,
  });

  return updated;
}

export async function archivePaymentMethod(id: string, input: ArchivePaymentMethodInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, archivePaymentMethodEndpoint(id));

    const paymentMethod = await getOwned(tx.payment_methods.findUnique({ where: { id } }), actor.businessId, "Payment method");

    if (paymentMethod.status === "archived") {
      const responseBody = JSON.parse(JSON.stringify({ data: paymentMethod })) as unknown;
      await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archivePaymentMethodEndpoint(id), 200, responseBody);
      return paymentMethod;
    }

    const result = await tx.payment_methods.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "active" },
      data: { status: "archived", version: { increment: 1 } },
    });
    if (result.count === 0) throw conflict("Payment method was modified concurrently, please retry with the latest version");
    const updated = await tx.payment_methods.findUniqueOrThrow({ where: { id } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "payment_method.archived",
      entityType: "payment_method",
      entityId: id,
      reason: `Payment method "${paymentMethod.name}" archived`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archivePaymentMethodEndpoint(id), 200, responseBody);
    return updated;
  });
}

export async function restorePaymentMethod(id: string, input: RestorePaymentMethodInput, actor: Actor, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, restorePaymentMethodEndpoint(id));

    const paymentMethod = await getOwned(tx.payment_methods.findUnique({ where: { id } }), actor.businessId, "Payment method");

    if (paymentMethod.status === "active") {
      const responseBody = JSON.parse(JSON.stringify({ data: paymentMethod })) as unknown;
      await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restorePaymentMethodEndpoint(id), 200, responseBody);
      return paymentMethod;
    }

    const result = await tx.payment_methods.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "archived" },
      data: { status: "active", version: { increment: 1 } },
    });
    if (result.count === 0) throw conflict("Payment method was modified concurrently, please retry with the latest version");
    const updated = await tx.payment_methods.findUniqueOrThrow({ where: { id } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "payment_method.restored",
      entityType: "payment_method",
      entityId: id,
      reason: `Payment method "${paymentMethod.name}" restored`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restorePaymentMethodEndpoint(id), 200, responseBody);
    return updated;
  });
}
