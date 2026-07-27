import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { getNextExpenseNumber } from "../lib/expenseNumber";
import { getCurrency } from "../lib/currencyReference";
import {
  CreateExpenseInput,
  UpdateExpenseInput,
  ListExpensesQuery,
  ArchiveExpenseInput,
  RestoreExpenseInput,
  AddAttachmentsInput,
  MAX_ATTACHMENTS,
} from "../validation/expense.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Neon's serverless HTTP driver adds real per-query latency, same reasoning
// Sales'/Debts' own transaction timeouts were raised for -- createExpense's
// transaction does a counter allocation + expense insert + attachment batch +
// audit log + idempotency completion, several sequential round trips deep.
const EXPENSE_TRANSACTION_OPTIONS = { timeout: 15000 };

export const CREATE_EXPENSE_ENDPOINT = "POST /expenses";
export function updateExpenseEndpoint(id: string): string {
  return `PATCH /expenses/${id}`;
}
export function archiveExpenseEndpoint(id: string): string {
  return `POST /expenses/${id}/archive`;
}
export function restoreExpenseEndpoint(id: string): string {
  return `POST /expenses/${id}/restore`;
}
export function addAttachmentsEndpoint(id: string): string {
  return `POST /expenses/${id}/attachments`;
}

export async function createExpense(input: CreateExpenseInput, actor: Actor, idempotencyKey: string) {
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });

  if (input.branchId) {
    const branch = await getOwned(prisma.branches.findUnique({ where: { id: input.branchId } }), actor.businessId, "Branch");
    if (branch.status !== "active") throw badRequest("Branch is archived");
  }
  const category = await getOwned(prisma.expense_categories.findUnique({ where: { id: input.categoryId } }), actor.businessId, "Expense category");
  if (!category.active) throw badRequest("Expense category is inactive");
  if (input.paymentMethodId) {
    const pm = await getOwned(prisma.payment_methods.findUnique({ where: { id: input.paymentMethodId } }), actor.businessId, "Payment method");
    if (pm.status !== "active") throw badRequest("Payment method is archived");
  }

  const amount = new Prisma.Decimal(input.amount);
  // Snapshotted at creation time -- fields only, no conversion logic (Module
  // 19's job). Symbol may legitimately be null for the ~50 currency codes
  // with no single-country association, same as documented elsewhere.
  const currency = getCurrency(business.currency);

  const expense = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_EXPENSE_ENDPOINT);

    const expenseNumber = await getNextExpenseNumber(tx, actor.businessId);

    const created = await tx.expenses.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        branch_id: input.branchId,
        scope: input.scope,
        category_id: category.id,
        category_name: category.name,
        amount,
        currency_code: currency?.code ?? business.currency,
        currency_symbol: currency?.symbol ?? null,
        tax_amount: input.taxAmount !== undefined ? new Prisma.Decimal(input.taxAmount) : undefined,
        tax_rate: input.taxRate !== undefined ? new Prisma.Decimal(input.taxRate) : undefined,
        tax_included: input.taxIncluded,
        payment_method_id: input.paymentMethodId,
        expense_date: input.expenseDate,
        vendor_id: input.vendorId,
        vendor_name: input.vendorName,
        reference_number: input.referenceNumber,
        description: input.description,
        notes: input.notes,
        source: input.source,
        recurring: input.recurring,
        recurrence_rule: input.recurrenceRule,
        created_by: actor.userId,
        expense_number: expenseNumber,
        status: "active",
      },
    });

    if (input.attachments && input.attachments.length > 0) {
      await tx.expense_attachments.createMany({
        data: input.attachments.map((a) => ({
          id: generateId(),
          business_id: actor.businessId,
          expense_id: created.id,
          filename: a.filename,
          mime_type: a.mimeType,
          size: a.size,
          storage_key: a.storageKey,
          uploaded_by: actor.userId,
        })),
      });
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "expense.created",
      entityType: "expense",
      entityId: created.id,
      reason: `Expense ${expenseNumber} of ${amount.toString()} recorded (${category.name})`,
    });

    const withAttachments = await tx.expenses.findUniqueOrThrow({ where: { id: created.id }, include: { expense_attachments: true } });
    const responseBody = JSON.parse(JSON.stringify({ data: withAttachments })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_EXPENSE_ENDPOINT, 201, responseBody);

    return withAttachments;
  }, EXPENSE_TRANSACTION_OPTIONS);

  domainEvents.publish("ExpenseCreated", {
    expenseId: expense.id,
    businessId: actor.businessId,
    branchId: expense.branch_id,
    categoryId: expense.category_id,
    amount: amount.toString(),
  });

  return expense;
}

export async function listExpenses(query: ListExpensesQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["expense_date", "amount", "created_at"] as const,
    defaultSort: "expense_date" as const,
    searchableFields: ["vendor_name", "reference_number", "description"],
  });

  const where: Prisma.expensesWhereInput = {
    business_id: businessId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.branchId ? { branch_id: query.branchId } : {}),
    ...(query.categoryId ? { category_id: query.categoryId } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(resolved.searchWhere ?? {}),
  };
  if (query.dateFrom || query.dateTo) {
    where.expense_date = {
      ...(query.dateFrom ? { gte: query.dateFrom } : {}),
      ...(query.dateTo ? { lte: query.dateTo } : {}),
    };
  }

  const [rows, total] = await Promise.all([
    prisma.expenses.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take, include: { expense_attachments: true } }),
    prisma.expenses.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

export async function getExpense(id: string, businessId: string) {
  return getOwned(prisma.expenses.findUnique({ where: { id }, include: { expense_attachments: true } }), businessId, "Expense");
}

export async function updateExpense(id: string, input: UpdateExpenseInput, actor: Actor, idempotencyKey: string) {
  const expense = await getOwned(prisma.expenses.findUnique({ where: { id } }), actor.businessId, "Expense");
  if (expense.status === "archived") throw badRequest("Cannot update an archived expense");

  // The Zod schema only validates internal consistency of what's PROVIDED --
  // cross-checking against the row's actual current scope/branch_id (for
  // whichever of the two the client didn't touch this call) has to happen
  // here, against real DB state.
  const nextScope = input.scope ?? expense.scope;
  const nextBranchId = input.branchId !== undefined ? input.branchId : expense.branch_id;
  if (nextScope === "business" && nextBranchId) throw badRequest("branchId must not be set when scope is business");
  if (nextScope === "branch" && !nextBranchId) throw badRequest("branchId is required when scope is branch");

  // Same reasoning as scope/branchId -- re-check the create-time "recurring
  // requires recurrenceRule" rule against the row's actual current state
  // merged with whatever's being changed this call, not just what's provided
  // (the Zod schema can't see stored state). Unlike scope/branchId, flipping
  // recurring back to false does NOT require also clearing recurrenceRule --
  // an orphaned rule string on a non-recurring expense is inert (nothing
  // reads it), not a real data-integrity question the way a stray branch_id
  // on a business-scoped expense would be.
  const nextRecurring = input.recurring ?? expense.recurring;
  const nextRecurrenceRule = input.recurrenceRule !== undefined ? input.recurrenceRule : expense.recurrence_rule;
  if (nextRecurring && !nextRecurrenceRule) throw badRequest("recurrenceRule is required when recurring is true");

  if (input.branchId) {
    const branch = await getOwned(prisma.branches.findUnique({ where: { id: input.branchId } }), actor.businessId, "Branch");
    if (branch.status !== "active") throw badRequest("Branch is archived");
  }
  let categoryName = expense.category_name;
  if (input.categoryId) {
    const category = await getOwned(prisma.expense_categories.findUnique({ where: { id: input.categoryId } }), actor.businessId, "Expense category");
    if (!category.active) throw badRequest("Expense category is inactive");
    categoryName = category.name;
  }
  if (input.paymentMethodId) {
    const pm = await getOwned(prisma.payment_methods.findUnique({ where: { id: input.paymentMethodId } }), actor.businessId, "Payment method");
    if (pm.status !== "active") throw badRequest("Payment method is archived");
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, updateExpenseEndpoint(id));

    const updateResult = await tx.expenses.updateMany({
      where: { id, business_id: actor.businessId, version: input.version },
      data: {
        branch_id: nextBranchId,
        scope: nextScope,
        category_id: input.categoryId,
        category_name: categoryName,
        amount: input.amount !== undefined ? new Prisma.Decimal(input.amount) : undefined,
        tax_amount: input.taxAmount === undefined ? undefined : input.taxAmount === null ? null : new Prisma.Decimal(input.taxAmount),
        tax_rate: input.taxRate === undefined ? undefined : input.taxRate === null ? null : new Prisma.Decimal(input.taxRate),
        tax_included: input.taxIncluded,
        payment_method_id: input.paymentMethodId,
        expense_date: input.expenseDate,
        vendor_id: input.vendorId,
        vendor_name: input.vendorName,
        reference_number: input.referenceNumber,
        description: input.description,
        notes: input.notes,
        recurring: nextRecurring,
        recurrence_rule: nextRecurrenceRule,
        version: { increment: 1 },
      },
    });
    if (updateResult.count === 0) {
      throw conflict("Expense was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "expense.updated",
      entityType: "expense",
      entityId: id,
      reason: `Expense ${expense.expense_number} updated`,
    });

    const updated = await tx.expenses.findUniqueOrThrow({ where: { id }, include: { expense_attachments: true } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, updateExpenseEndpoint(id), 200, responseBody);

    return updated;
  }, EXPENSE_TRANSACTION_OPTIONS);

  domainEvents.publish("ExpenseUpdated", { expenseId: id, businessId: actor.businessId });

  return result;
}

export async function archiveExpense(id: string, input: ArchiveExpenseInput, actor: Actor, idempotencyKey: string) {
  const expense = await getOwned(prisma.expenses.findUnique({ where: { id } }), actor.businessId, "Expense");
  if (expense.status === "archived") throw badRequest("Expense is already archived");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveExpenseEndpoint(id));

    const updateResult = await tx.expenses.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "active" },
      data: { status: "archived", archived_reason: input.reason, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Expense was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "expense.archived",
      entityType: "expense",
      entityId: id,
      reason: input.reason,
    });

    const updated = await tx.expenses.findUniqueOrThrow({ where: { id } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveExpenseEndpoint(id), 200, responseBody);
    return updated;
  }, EXPENSE_TRANSACTION_OPTIONS);

  domainEvents.publish("ExpenseArchived", { expenseId: id, businessId: actor.businessId, reason: input.reason });

  return result;
}

export async function restoreExpense(id: string, input: RestoreExpenseInput, actor: Actor, idempotencyKey: string) {
  const expense = await getOwned(prisma.expenses.findUnique({ where: { id } }), actor.businessId, "Expense");
  if (expense.status === "active") throw badRequest("Expense is not archived");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreExpenseEndpoint(id));

    const updateResult = await tx.expenses.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "archived" },
      data: { status: "active", archived_reason: null, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Expense was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "expense.restored",
      entityType: "expense",
      entityId: id,
      reason: `Expense ${expense.expense_number} restored`,
    });

    const updated = await tx.expenses.findUniqueOrThrow({ where: { id } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreExpenseEndpoint(id), 200, responseBody);
    return updated;
  }, EXPENSE_TRANSACTION_OPTIONS);

  return result;
}

export async function addAttachments(id: string, input: AddAttachmentsInput, actor: Actor, idempotencyKey: string) {
  const expense = await getOwned(
    prisma.expenses.findUnique({ where: { id }, include: { expense_attachments: true } }),
    actor.businessId,
    "Expense"
  );
  if (expense.status === "archived") throw badRequest("Cannot add attachments to an archived expense");
  if (expense.expense_attachments.length + input.attachments.length > MAX_ATTACHMENTS) {
    throw badRequest(`An expense cannot have more than ${MAX_ATTACHMENTS} attachments`);
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, addAttachmentsEndpoint(id));

    await tx.expense_attachments.createMany({
      data: input.attachments.map((a) => ({
        id: generateId(),
        business_id: actor.businessId,
        expense_id: id,
        filename: a.filename,
        mime_type: a.mimeType,
        size: a.size,
        storage_key: a.storageKey,
        uploaded_by: actor.userId,
      })),
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "expense.attachments_added",
      entityType: "expense",
      entityId: id,
      reason: `${input.attachments.length} attachment(s) added to expense ${expense.expense_number}`,
    });

    const updated = await tx.expenses.findUniqueOrThrow({ where: { id }, include: { expense_attachments: true } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, addAttachmentsEndpoint(id), 201, responseBody);
    return updated;
  }, EXPENSE_TRANSACTION_OPTIONS);

  return result;
}
