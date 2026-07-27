import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { paginate, resolveListQuery } from "../lib/pagination";
import type { CreateExpenseCategoryInput, UpdateExpenseCategoryInput, ListExpenseCategoriesQuery } from "../validation/expenseCategory.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Seeded lazily on first access rather than at signup -- editing already-
// shipped, tested auth.service.ts for this is a bigger, riskier touch than
// necessary, and a lazy approach self-heals every business that existed
// before this module shipped (real businesses in the live DB today would
// otherwise never get seeded). Relies on @@unique([business_id, name]) for
// idempotency -- safe to call on every access.
const SYSTEM_CATEGORY_NAMES = ["Rent", "Electricity", "Payroll", "Transport", "Misc"] as const;

type Db = typeof prisma | Prisma.TransactionClient;

export async function ensureSystemCategoriesSeeded(db: Db, businessId: string): Promise<void> {
  await db.expense_categories.createMany({
    data: SYSTEM_CATEGORY_NAMES.map((name) => ({
      id: generateId(),
      business_id: businessId,
      name,
      type: "system",
    })),
    skipDuplicates: true,
  });
}

export async function createExpenseCategory(input: CreateExpenseCategoryInput, actor: Actor) {
  await ensureSystemCategoriesSeeded(prisma, actor.businessId);

  const existing = await prisma.expense_categories.findUnique({
    where: { business_id_name: { business_id: actor.businessId, name: input.name } },
  });
  if (existing) throw badRequest(`A category named "${input.name}" already exists`);

  const category = await prisma.expense_categories.create({
    data: {
      id: generateId(),
      business_id: actor.businessId,
      name: input.name,
      type: "custom",
      color: input.color,
    },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "expense_category.created",
    entityType: "expense_category",
    entityId: category.id,
    reason: `Custom expense category "${category.name}" created`,
  });

  return category;
}

export async function listExpenseCategories(query: ListExpenseCategoriesQuery, businessId: string) {
  await ensureSystemCategoriesSeeded(prisma, businessId);

  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at"] as const,
    defaultSort: "name" as const,
    searchableFields: ["name"],
  });

  const where: Prisma.expense_categoriesWhereInput = {
    business_id: businessId,
    ...(query.active !== undefined ? { active: query.active } : {}),
    ...(resolved.searchWhere ?? {}),
  };

  const [rows, total] = await Promise.all([
    prisma.expense_categories.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.expense_categories.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

export async function updateExpenseCategory(id: string, input: UpdateExpenseCategoryInput, actor: Actor) {
  const category = await getOwned(prisma.expense_categories.findUnique({ where: { id } }), actor.businessId, "Expense category");
  if (category.type === "system") throw badRequest("System categories cannot be modified");

  const updated = await prisma.expense_categories.update({
    where: { id },
    data: { name: input.name, color: input.color },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "expense_category.updated",
    entityType: "expense_category",
    entityId: id,
    reason: `Custom expense category "${category.name}" updated`,
  });

  return updated;
}

export async function deactivateExpenseCategory(id: string, actor: Actor) {
  const category = await getOwned(prisma.expense_categories.findUnique({ where: { id } }), actor.businessId, "Expense category");
  if (category.type === "system") throw badRequest("System categories cannot be deactivated");
  if (!category.active) throw badRequest("Category is already inactive");

  const updated = await prisma.expense_categories.update({ where: { id }, data: { active: false } });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "expense_category.deactivated",
    entityType: "expense_category",
    entityId: id,
    reason: `Custom expense category "${category.name}" deactivated`,
  });

  return updated;
}
