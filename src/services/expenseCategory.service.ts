import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { paginate, resolveListQuery } from "../lib/pagination";
import type { CreateExpenseCategoryInput, UpdateExpenseCategoryInput, ListExpenseCategoriesQuery } from "../validation/expenseCategory.schema";

function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

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
//
// "Inventory Purchases" added in Module 11 Session B -- the auto-created
// Expense behind a PO payment (createExpenseInTransaction) needs a
// category_id, and none of the original 5 fit "money paid to a supplier for
// goods." Added here rather than a one-off special case so it self-heals
// existing businesses the same way the original 5 do.
const SYSTEM_CATEGORY_NAMES = ["Rent", "Electricity", "Payroll", "Transport", "Misc", "Inventory Purchases"] as const;

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

  // Batch 6 (HNT2-EXP-001) -- scoped to active only, matching the new
  // active-only partial unique index: a name held only by an inactive
  // category is now legitimately reusable by a new one.
  const existing = await prisma.expense_categories.findFirst({
    where: { business_id: actor.businessId, name: input.name, active: true },
  });
  if (existing) throw badRequest(`A category named "${input.name}" already exists`);

  let category;
  try {
    category = await prisma.expense_categories.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        name: input.name,
        type: "custom",
        color: input.color,
      },
    });
  } catch (err) {
    if (isP2002(err)) throw conflict(`A category named "${input.name}" already exists`);
    throw err;
  }

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

// Batch 6 micro-fix (adjacent to HNT2-EXP-001, logged as its own line item,
// not part of restore): a duplicate-name rename used to surface as a raw,
// uncaught Prisma P2002 -- now converted to this repo's standard
// deterministic 409. Reachable more often now that the active-only partial
// unique index exists (a rename can collide with any other active
// category), but the underlying gap predates this batch.
export async function updateExpenseCategory(id: string, input: UpdateExpenseCategoryInput, actor: Actor) {
  const category = await getOwned(prisma.expense_categories.findUnique({ where: { id } }), actor.businessId, "Expense category");
  if (category.type === "system") throw badRequest("System categories cannot be modified");

  let updated;
  try {
    updated = await prisma.expense_categories.update({
      where: { id },
      data: { name: input.name, color: input.color },
    });
  } catch (err) {
    if (isP2002(err)) throw conflict(`A category named "${input.name}" already exists`);
    throw err;
  }

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

// Batch 6 (HNT2-EXP-001) -- deactivate. Converted to the same atomic
// active:true->false guard as restore below, for symmetry: a concurrent
// deactivate-vs-restore race now resolves cleanly on both sides, not just
// the new restore path.
export async function deactivateExpenseCategory(id: string, actor: Actor) {
  const category = await getOwned(prisma.expense_categories.findUnique({ where: { id } }), actor.businessId, "Expense category");
  if (category.type === "system") throw badRequest("System categories cannot be deactivated");
  if (!category.active) throw badRequest("Category is already inactive");

  const result = await prisma.expense_categories.updateMany({
    where: { id, business_id: actor.businessId, active: true },
    data: { active: false },
  });
  if (result.count === 0) throw conflict("Category state changed concurrently, please retry");
  const updated = await prisma.expense_categories.findUniqueOrThrow({ where: { id } });

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

// Batch 6 (HNT2-EXP-001) -- restore. State-idempotent by design: an
// already-active owned custom category returns its current representation
// as a successful no-op (NOT a 400 -- a plain "already active" error here
// would directly contradict idempotent replay, the exact bug this design
// was corrected to avoid). A genuine collision with a different active
// category now holding the same name converts P2002 to a clean 409.
export async function restoreExpenseCategory(id: string, actor: Actor) {
  const category = await getOwned(prisma.expense_categories.findUnique({ where: { id } }), actor.businessId, "Expense category");
  if (category.type === "system") throw badRequest("System categories cannot be restored");

  if (category.active) return category;

  let updated;
  try {
    const result = await prisma.expense_categories.updateMany({
      where: { id, business_id: actor.businessId, active: false },
      data: { active: true },
    });
    if (result.count === 0) {
      // Lost a race to a concurrent restore between the read above and this
      // write -- if it's now active, that's the SAME idempotent-success
      // outcome as the up-front check, just discovered mid-flight.
      const fresh = await prisma.expense_categories.findUniqueOrThrow({ where: { id } });
      if (fresh.active) return fresh;
      throw conflict("Category could not be restored -- state changed concurrently");
    }
    updated = await prisma.expense_categories.findUniqueOrThrow({ where: { id } });
  } catch (err) {
    if (isP2002(err)) throw conflict(`Cannot restore -- an active category named "${category.name}" already exists`);
    throw err;
  }

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "expense_category.restored",
    entityType: "expense_category",
    entityId: id,
    reason: `Custom expense category "${category.name}" restored`,
  });

  return updated;
}
