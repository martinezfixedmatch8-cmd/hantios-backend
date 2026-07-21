import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest } from "../lib/errors";
import type {
  CreatePaymentMethodInput,
  UpdatePaymentMethodInput,
  ListPaymentMethodsQuery,
} from "../validation/paymentMethod.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export async function createPaymentMethod(input: CreatePaymentMethodInput, actor: Actor) {
  const paymentMethod = await prisma.payment_methods.create({
    data: {
      id: generateId(),
      business_id: actor.businessId,
      name: input.name,
      logo_url: input.logoUrl,
      account_number: input.accountNumber,
      description: input.description,
    },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "payment_method.created",
    entityType: "payment_method",
    entityId: paymentMethod.id,
    reason: `Payment method "${paymentMethod.name}" created`,
  });

  return paymentMethod;
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

export async function updatePaymentMethod(id: string, input: UpdatePaymentMethodInput, actor: Actor) {
  await getOwned(prisma.payment_methods.findUnique({ where: { id } }), actor.businessId, "Payment method");

  const updated = await prisma.payment_methods.update({
    where: { id },
    data: {
      name: input.name,
      logo_url: input.logoUrl,
      account_number: input.accountNumber,
      description: input.description,
    },
  });

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

export async function archivePaymentMethod(id: string, actor: Actor) {
  const paymentMethod = await getOwned(prisma.payment_methods.findUnique({ where: { id } }), actor.businessId, "Payment method");
  if (paymentMethod.status === "archived") {
    throw badRequest("Payment method is already archived");
  }

  const updated = await prisma.payment_methods.update({ where: { id }, data: { status: "archived" } });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "payment_method.archived",
    entityType: "payment_method",
    entityId: id,
    reason: `Payment method "${paymentMethod.name}" archived`,
  });

  return updated;
}

export async function restorePaymentMethod(id: string, actor: Actor) {
  const paymentMethod = await getOwned(prisma.payment_methods.findUnique({ where: { id } }), actor.businessId, "Payment method");
  if (paymentMethod.status === "active") {
    throw badRequest("Payment method is not archived");
  }

  const updated = await prisma.payment_methods.update({ where: { id }, data: { status: "active" } });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "payment_method.restored",
    entityType: "payment_method",
    entityId: id,
    reason: `Payment method "${paymentMethod.name}" restored`,
  });

  return updated;
}
