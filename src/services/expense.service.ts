import { Prisma, ExpenseScope, ExpenseSource, RecurrenceFrequency } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict, notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { getNextExpenseNumber } from "../lib/expenseNumber";
import { getCurrency } from "../lib/currencyReference";
import { getStorageProvider } from "../storage/registry";
import {
  CreateExpenseInput,
  UpdateExpenseInput,
  ListExpensesQuery,
  ArchiveExpenseInput,
  RestoreExpenseInput,
  AddAttachmentsInput,
  ApproveExpenseInput,
  RejectExpenseInput,
  MarkPaidExpenseInput,
  UpdateRecurrenceInput,
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

// Shared shape for every response that returns an expense -- tags/
// recurrence are new in Session 5B, included everywhere an expense is
// returned so a client never needs a second round trip for them.
const EXPENSE_INCLUDE = {
  expense_attachments: true,
  expense_tags: { include: { tags: true } },
  expense_recurrence: true,
} as const;

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
export function deleteAttachmentEndpoint(id: string, attachmentId: string): string {
  return `DELETE /expenses/${id}/attachments/${attachmentId}`;
}
export function approveExpenseEndpoint(id: string): string {
  return `POST /expenses/${id}/approve`;
}
export function rejectExpenseEndpoint(id: string): string {
  return `POST /expenses/${id}/reject`;
}
export function markPaidExpenseEndpoint(id: string): string {
  return `POST /expenses/${id}/mark-paid`;
}
export function updateRecurrenceEndpoint(id: string): string {
  return `PATCH /expenses/${id}/recurrence`;
}

async function validateTagIds(tagIds: string[] | undefined, businessId: string): Promise<void> {
  if (!tagIds || tagIds.length === 0) return;
  const found = await prisma.tags.count({ where: { id: { in: tagIds }, business_id: businessId } });
  if (found !== tagIds.length) {
    throw badRequest("One or more tagIds are invalid or belong to a different business");
  }
}

// Module 11 Session B -- extracted from createExpense's own transaction body
// so a PO payment (purchaseOrderPayment.service.ts) can create its linked
// Expense atomically inside its OWN transaction, without nesting a second
// `prisma.$transaction` (Prisma interactive transactions in this repo are
// always a single top-level `tx`, matching writeAuditLog/claimIdempotencyKey's
// own tx-accepting shape). Deliberately does NOT claim/complete an
// idempotency key or publish a domain event -- both stay the CALLER's
// responsibility, exactly once, at whichever endpoint actually owns this
// transaction (createExpense itself, or recordPurchaseOrderPayment).
export interface CreateExpenseInTransactionInput {
  businessId: string;
  branchId: string | null;
  scope: ExpenseScope;
  category: { id: string; name: string };
  amount: Prisma.Decimal;
  currencyCode: string;
  currencySymbol: string | null;
  taxAmount?: Prisma.Decimal;
  taxRate?: Prisma.Decimal;
  taxIncluded?: boolean;
  paymentMethodId?: string | null;
  expenseDate: Date;
  vendorId?: string | null;
  vendorName?: string | null;
  referenceNumber?: string | null;
  description?: string | null;
  notes?: string | null;
  source: ExpenseSource;
  createdBy: string;
  attachments?: { filename: string; mimeType: string; size: number; storageKey: string }[];
  tagIds?: string[];
  recurrence?: { frequency: RecurrenceFrequency; interval: number; nextRun?: Date };
  // Module 11 Session B -- populated only when source === "purchase_order".
  purchaseOrderId?: string | null;
  poNumber?: string | null;
  grnNumber?: string | null;
  // When set, bypasses the normal "always creates in pending" rule -- used
  // exclusively by PO Payments: the payment recording IS the approval+paid
  // event, just via a different path than the manual approve/mark-paid
  // endpoints, so all four actor/timestamp fields are stamped together.
  workflowOverride?: { status: "paid"; approvedBy: string; approvedAt: Date; paidBy: string; paidAt: Date };
  actorUserName: string;
  actorUserRole: string;
}

export async function createExpenseInTransaction(tx: Prisma.TransactionClient, input: CreateExpenseInTransactionInput) {
  const expenseNumber = await getNextExpenseNumber(tx, input.businessId);

  const created = await tx.expenses.create({
    data: {
      id: generateId(),
      business_id: input.businessId,
      branch_id: input.branchId,
      scope: input.scope,
      category_id: input.category.id,
      category_name: input.category.name,
      amount: input.amount,
      currency_code: input.currencyCode,
      currency_symbol: input.currencySymbol,
      tax_amount: input.taxAmount,
      tax_rate: input.taxRate,
      tax_included: input.taxIncluded,
      payment_method_id: input.paymentMethodId,
      expense_date: input.expenseDate,
      vendor_id: input.vendorId,
      vendor_name: input.vendorName,
      reference_number: input.referenceNumber,
      description: input.description,
      notes: input.notes,
      source: input.source,
      // Spec named only create/approve/reject/mark-paid as actions, with no
      // "submit" -- createExpense always creates directly in `pending`
      // (confirmed with the user). `draft` stays in the enum, unreachable.
      // A PO payment is the one exception (workflowOverride) -- confirmed
      // with the user, not assumed silently.
      workflow_status: input.workflowOverride ? input.workflowOverride.status : "pending",
      approved_by: input.workflowOverride?.approvedBy ?? null,
      approved_at: input.workflowOverride?.approvedAt ?? null,
      paid_by: input.workflowOverride?.paidBy ?? null,
      paid_at: input.workflowOverride?.paidAt ?? null,
      created_by: input.createdBy,
      expense_number: expenseNumber,
      status: "active",
      purchase_order_id: input.purchaseOrderId ?? null,
      po_number: input.poNumber ?? null,
      grn_number: input.grnNumber ?? null,
    },
  });

  if (input.attachments && input.attachments.length > 0) {
    // Module 11 Negotiation Session -- routed through StorageProvider
    // (previously a raw pass-through of the client-supplied storageKey).
    // The stub implementation returns the same key unchanged, so this is
    // behavior-identical to before; it's the seam a real storage backend
    // slots into later without this call site changing again.
    const registered = await Promise.all(
      input.attachments.map((a) =>
        getStorageProvider().registerUpload({
          businessId: input.businessId,
          fileName: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.size,
          clientStorageKey: a.storageKey,
        })
      )
    );
    await tx.expense_attachments.createMany({
      data: input.attachments.map((a, i) => ({
        id: generateId(),
        business_id: input.businessId,
        expense_id: created.id,
        filename: a.filename,
        mime_type: a.mimeType,
        size: a.size,
        storage_key: registered[i].storageKey,
        uploaded_by: input.createdBy,
      })),
    });
  }

  if (input.tagIds && input.tagIds.length > 0) {
    await tx.expense_tags.createMany({
      data: input.tagIds.map((tagId) => ({ expense_id: created.id, tag_id: tagId })),
    });
  }

  if (input.recurrence) {
    await tx.expense_recurrence.create({
      data: {
        id: generateId(),
        business_id: input.businessId,
        template_expense_id: created.id,
        frequency: input.recurrence.frequency,
        interval: input.recurrence.interval,
        next_run: input.recurrence.nextRun,
      },
    });
  }

  await writeAuditLog(tx, {
    businessId: input.businessId,
    userId: input.createdBy,
    userName: input.actorUserName,
    userRole: input.actorUserRole,
    action: "expense.created",
    entityType: "expense",
    entityId: created.id,
    reason: `Expense ${expenseNumber} of ${input.amount.toString()} recorded (${input.category.name})`,
  });

  return tx.expenses.findUniqueOrThrow({ where: { id: created.id }, include: EXPENSE_INCLUDE });
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
  await validateTagIds(input.tagIds, actor.businessId);

  const amount = new Prisma.Decimal(input.amount);
  // Snapshotted at creation time -- fields only, no conversion logic (Module
  // 19's job). Symbol may legitimately be null for the ~50 currency codes
  // with no single-country association, same as documented elsewhere.
  const currency = getCurrency(business.currency);

  const expense = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_EXPENSE_ENDPOINT);

    const withRelations = await createExpenseInTransaction(tx, {
      businessId: actor.businessId,
      branchId: input.branchId ?? null,
      scope: input.scope,
      category: { id: category.id, name: category.name },
      amount,
      currencyCode: currency?.code ?? business.currency,
      currencySymbol: currency?.symbol ?? null,
      taxAmount: input.taxAmount !== undefined ? new Prisma.Decimal(input.taxAmount) : undefined,
      taxRate: input.taxRate !== undefined ? new Prisma.Decimal(input.taxRate) : undefined,
      taxIncluded: input.taxIncluded,
      paymentMethodId: input.paymentMethodId ?? null,
      expenseDate: input.expenseDate,
      vendorId: input.vendorId ?? null,
      vendorName: input.vendorName ?? null,
      referenceNumber: input.referenceNumber ?? null,
      description: input.description ?? null,
      notes: input.notes ?? null,
      source: input.source,
      createdBy: actor.userId,
      attachments: input.attachments,
      tagIds: input.tagIds,
      recurrence: input.recurrence,
      actorUserName: actor.userName,
      actorUserRole: actor.userRole,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: withRelations })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_EXPENSE_ENDPOINT, 201, responseBody);

    return withRelations;
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
    ...(query.workflowStatus ? { workflow_status: query.workflowStatus } : {}),
    ...(query.branchId ? { branch_id: query.branchId } : {}),
    ...(query.categoryId ? { category_id: query.categoryId } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(query.tagId ? { expense_tags: { some: { tag_id: query.tagId } } } : {}),
    ...(resolved.searchWhere ?? {}),
  };
  if (query.dateFrom || query.dateTo) {
    where.expense_date = {
      ...(query.dateFrom ? { gte: query.dateFrom } : {}),
      ...(query.dateTo ? { lte: query.dateTo } : {}),
    };
  }

  const [rows, total] = await Promise.all([
    prisma.expenses.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take, include: EXPENSE_INCLUDE }),
    prisma.expenses.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

export async function getExpense(id: string, businessId: string) {
  return getOwned(prisma.expenses.findUnique({ where: { id }, include: EXPENSE_INCLUDE }), businessId, "Expense");
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
  await validateTagIds(input.tagIds, actor.businessId);

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
        version: { increment: 1 },
      },
    });
    if (updateResult.count === 0) {
      throw conflict("Expense was modified concurrently, please retry with the latest version");
    }

    // Full-replace semantics: omitted = untouched, [] = clear all, a list =
    // the complete desired set. expense_tags carries no data beyond the two
    // FKs, so delete-then-recreate is simplest and correct here.
    if (input.tagIds !== undefined) {
      await tx.expense_tags.deleteMany({ where: { expense_id: id } });
      if (input.tagIds.length > 0) {
        await tx.expense_tags.createMany({ data: input.tagIds.map((tagId) => ({ expense_id: id, tag_id: tagId })) });
      }
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

    const updated = await tx.expenses.findUniqueOrThrow({ where: { id }, include: EXPENSE_INCLUDE });
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

    const registered = await Promise.all(
      input.attachments.map((a) =>
        getStorageProvider().registerUpload({
          businessId: actor.businessId,
          fileName: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.size,
          clientStorageKey: a.storageKey,
        })
      )
    );
    await tx.expense_attachments.createMany({
      data: input.attachments.map((a, i) => ({
        id: generateId(),
        business_id: actor.businessId,
        expense_id: id,
        filename: a.filename,
        mime_type: a.mimeType,
        size: a.size,
        storage_key: registered[i].storageKey,
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

export async function deleteAttachment(id: string, attachmentId: string, actor: Actor, idempotencyKey: string) {
  const expense = await getOwned(prisma.expenses.findUnique({ where: { id } }), actor.businessId, "Expense");
  if (expense.status === "archived") throw badRequest("Cannot delete attachments from an archived expense");

  const attachment = await getOwned(prisma.expense_attachments.findUnique({ where: { id: attachmentId } }), actor.businessId, "Attachment");
  if (attachment.expense_id !== id) throw notFound("Attachment not found");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, deleteAttachmentEndpoint(id, attachmentId));

    await tx.expense_attachments.delete({ where: { id: attachmentId } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "expense.attachment_deleted",
      entityType: "expense_attachment",
      entityId: attachmentId,
      reason: `Attachment "${attachment.filename}" deleted from expense ${expense.expense_number}`,
    });

    const updated = await tx.expenses.findUniqueOrThrow({ where: { id }, include: { expense_attachments: true } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, deleteAttachmentEndpoint(id, attachmentId), 200, responseBody);
    return updated;
  }, EXPENSE_TRANSACTION_OPTIONS);

  return result;
}

// --- Status workflow (Session 5B) ---
// Single-step transitions only, matching the locked spec -- no multi-level
// approval chains. `rejected` is terminal this session (confirmed, not
// silently assumed): no resubmit/reopen path, correcting a rejected expense
// means creating a new one.

export async function approveExpense(id: string, input: ApproveExpenseInput, actor: Actor, idempotencyKey: string) {
  const expense = await getOwned(prisma.expenses.findUnique({ where: { id } }), actor.businessId, "Expense");
  if (expense.workflow_status !== "pending") {
    throw badRequest(`Cannot approve an expense with workflow status "${expense.workflow_status}"`);
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, approveExpenseEndpoint(id));

    const updateResult = await tx.expenses.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, workflow_status: "pending" },
      data: { workflow_status: "approved", approved_by: actor.userId, approved_at: new Date(), version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Expense was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "expense.approved",
      entityType: "expense",
      entityId: id,
      reason: `Expense ${expense.expense_number} approved`,
    });

    const updated = await tx.expenses.findUniqueOrThrow({ where: { id } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, approveExpenseEndpoint(id), 200, responseBody);
    return updated;
  }, EXPENSE_TRANSACTION_OPTIONS);

  domainEvents.publish("ExpenseApproved", { expenseId: id, businessId: actor.businessId, approvedBy: actor.userId });

  return result;
}

export async function rejectExpense(id: string, input: RejectExpenseInput, actor: Actor, idempotencyKey: string) {
  const expense = await getOwned(prisma.expenses.findUnique({ where: { id } }), actor.businessId, "Expense");
  if (expense.workflow_status !== "pending") {
    throw badRequest(`Cannot reject an expense with workflow status "${expense.workflow_status}"`);
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, rejectExpenseEndpoint(id));

    const updateResult = await tx.expenses.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, workflow_status: "pending" },
      data: { workflow_status: "rejected", rejected_by: actor.userId, rejected_at: new Date(), version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Expense was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "expense.rejected",
      entityType: "expense",
      entityId: id,
      reason: input.reason,
    });

    const updated = await tx.expenses.findUniqueOrThrow({ where: { id } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, rejectExpenseEndpoint(id), 200, responseBody);
    return updated;
  }, EXPENSE_TRANSACTION_OPTIONS);

  domainEvents.publish("ExpenseRejected", { expenseId: id, businessId: actor.businessId, rejectedBy: actor.userId, reason: input.reason });

  return result;
}

export async function markExpensePaid(id: string, input: MarkPaidExpenseInput, actor: Actor, idempotencyKey: string) {
  const expense = await getOwned(prisma.expenses.findUnique({ where: { id } }), actor.businessId, "Expense");
  if (expense.workflow_status !== "approved") {
    throw badRequest(`Cannot mark paid an expense with workflow status "${expense.workflow_status}"`);
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, markPaidExpenseEndpoint(id));

    const updateResult = await tx.expenses.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, workflow_status: "approved" },
      data: { workflow_status: "paid", paid_by: actor.userId, paid_at: new Date(), version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Expense was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "expense.paid",
      entityType: "expense",
      entityId: id,
      reason: `Expense ${expense.expense_number} marked paid`,
    });

    const updated = await tx.expenses.findUniqueOrThrow({ where: { id } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, markPaidExpenseEndpoint(id), 200, responseBody);
    return updated;
  }, EXPENSE_TRANSACTION_OPTIONS);

  domainEvents.publish("ExpensePaid", { expenseId: id, businessId: actor.businessId, paidBy: actor.userId });

  return result;
}

// --- Recurrence schedule management (Session 5B, architecture-only) ---

export async function updateRecurrence(id: string, input: UpdateRecurrenceInput, actor: Actor, idempotencyKey: string) {
  await getOwned(prisma.expenses.findUnique({ where: { id } }), actor.businessId, "Expense");
  const recurrence = await getOwned(
    prisma.expense_recurrence.findUnique({ where: { template_expense_id: id } }),
    actor.businessId,
    "Expense recurrence schedule"
  );

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, updateRecurrenceEndpoint(id));

    const updated = await tx.expense_recurrence.update({
      where: { id: recurrence.id },
      data: {
        frequency: input.frequency,
        interval: input.interval,
        next_run: input.nextRun,
        active: input.active,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "expense_recurrence.updated",
      entityType: "expense_recurrence",
      entityId: updated.id,
      reason: `Recurrence schedule for expense ${id} updated`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, updateRecurrenceEndpoint(id), 200, responseBody);
    return updated;
  }, EXPENSE_TRANSACTION_OPTIONS);

  return result;
}
