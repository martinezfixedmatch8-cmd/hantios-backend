import { z } from "zod";
import { ExpenseScope, ExpenseSource, ExpenseWorkflowStatus, RecurrenceFrequency } from "@prisma/client";
import { decimalField, idParamSchema } from "./common.schema";
import { paginationQuerySchema } from "../lib/pagination";

export { idParamSchema };

// Metadata-only this session (locked decision -- no StorageProvider exists
// anywhere in this repo despite CLAUDE.md's roadmap entry claiming
// otherwise). storageKey is an opaque, client-supplied reference string;
// actual file-byte upload/storage wiring is a separate, future concern.
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_EXPENSE = 5;
const ALLOWED_ATTACHMENT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"] as const;
const MAX_TAGS_PER_EXPENSE = 20;

export const attachmentInputSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(ALLOWED_ATTACHMENT_MIME_TYPES),
  size: z.coerce.number().int().positive().max(MAX_ATTACHMENT_SIZE_BYTES),
  storageKey: z.string().trim().min(1).max(500),
});
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

// Session 5B -- architecture-only (no scheduler reads this yet). Setup is
// folded into createExpenseSchema rather than a separate endpoint; changing
// an existing schedule goes through updateRecurrenceSchema below.
export const recurrenceInputSchema = z.object({
  frequency: z.nativeEnum(RecurrenceFrequency),
  interval: z.number().int().positive().optional().default(1),
  nextRun: z.coerce.date().optional(),
});
export type RecurrenceInput = z.infer<typeof recurrenceInputSchema>;

export const updateRecurrenceSchema = z.object({
  frequency: z.nativeEnum(RecurrenceFrequency).optional(),
  interval: z.number().int().positive().optional(),
  nextRun: z.coerce.date().optional().nullable(),
  active: z.boolean().optional(),
});
export type UpdateRecurrenceInput = z.infer<typeof updateRecurrenceSchema>;

function withScopeRefine<T extends z.ZodType<{ scope?: ExpenseScope; branchId?: string | null }>>(schema: T) {
  return schema.superRefine((data, ctx) => {
    if (data.scope === undefined) return;
    if (data.scope === "business" && data.branchId) {
      ctx.addIssue({ code: "custom", message: "branchId must not be set when scope is business", path: ["branchId"] });
    }
    if (data.scope === "branch" && !data.branchId) {
      ctx.addIssue({ code: "custom", message: "branchId is required when scope is branch", path: ["branchId"] });
    }
  });
}

// recurring/recurrenceRule (5A's simple boolean+free-text fields) are gone --
// deprecated in favor of the recurrence object below, whose mere presence on
// an expense_recurrence row is now the sole source of truth for "is this
// expense recurring" (see schema.prisma's expenses model comment).
export const createExpenseSchema = withScopeRefine(
  z.object({
    branchId: z.string().uuid().optional(),
    scope: z.nativeEnum(ExpenseScope),
    categoryId: z.string().uuid(),
    amount: decimalField(z.coerce.number().positive()),
    // Tax Snapshot -- fields only, manually entered, no calculation logic
    // (matches the currency snapshot's own "fields only" pattern). Never
    // derived from `amount`, and never used to derive it either.
    taxAmount: decimalField(z.coerce.number().nonnegative()).optional(),
    taxRate: decimalField(z.coerce.number().min(0).max(100)).optional(),
    taxIncluded: z.boolean().optional(),
    paymentMethodId: z.string().uuid().optional(),
    expenseDate: z.coerce.date(),
    vendorId: z.string().trim().min(1).max(100).optional(),
    vendorName: z.string().trim().min(1).max(200).optional(),
    referenceNumber: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(5000).optional(),
    source: z.nativeEnum(ExpenseSource).optional().default("manual"),
    attachments: z.array(attachmentInputSchema).max(MAX_ATTACHMENTS_PER_EXPENSE).optional(),
    tagIds: z.array(z.string().uuid()).max(MAX_TAGS_PER_EXPENSE).optional(),
    recurrence: recurrenceInputSchema.optional(),
  })
);
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

// Every genuinely-nullable-in-DB field below is `.nullable()` here, unlike
// createExpenseSchema -- an update needs a way to explicitly CLEAR a
// previously-set value (e.g. flip scope back to "business"), which a bare
// `.optional()` can never express: omitting the key means "leave unchanged,"
// but there was previously no way to send an explicit `null` either, since
// `.optional()` alone rejects it at the base type check. QA caught this for
// branchId specifically (Session 5A); the same structural gap applied to
// every other clearable field, fixed here uniformly. Prisma's own update
// semantics already do the right thing once the type allows null through:
// undefined -> skip, null -> clear, a value -> set it.
export const updateExpenseSchema = withScopeRefine(
  z.object({
    version: z.number().int().nonnegative(),
    branchId: z.string().uuid().optional().nullable(),
    scope: z.nativeEnum(ExpenseScope).optional(),
    categoryId: z.string().uuid().optional(),
    amount: decimalField(z.coerce.number().positive()).optional(),
    taxAmount: decimalField(z.coerce.number().nonnegative()).optional().nullable(),
    taxRate: decimalField(z.coerce.number().min(0).max(100)).optional().nullable(),
    taxIncluded: z.boolean().optional().nullable(),
    paymentMethodId: z.string().uuid().optional().nullable(),
    expenseDate: z.coerce.date().optional(),
    vendorId: z.string().trim().min(1).max(100).optional().nullable(),
    vendorName: z.string().trim().min(1).max(200).optional().nullable(),
    referenceNumber: z.string().trim().min(1).max(100).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
    // Full-replace semantics: omitted = tags untouched, [] = clear all tags,
    // a list = the complete desired tag set (diffed into adds/removes
    // server-side, not merged with whatever was there before).
    tagIds: z.array(z.string().uuid()).max(MAX_TAGS_PER_EXPENSE).optional(),
  })
);
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

export const addAttachmentsSchema = z.object({
  attachments: z.array(attachmentInputSchema).min(1).max(MAX_ATTACHMENTS_PER_EXPENSE),
});
export type AddAttachmentsInput = z.infer<typeof addAttachmentsSchema>;

export const archiveExpenseSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type ArchiveExpenseInput = z.infer<typeof archiveExpenseSchema>;

export const restoreExpenseSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type RestoreExpenseInput = z.infer<typeof restoreExpenseSchema>;

// No "reason" here -- approving is just "yes, this is fine," unlike reject.
export const approveExpenseSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type ApproveExpenseInput = z.infer<typeof approveExpenseSchema>;

// Reason required though not explicitly asked in the 5B spec -- every other
// negative/blocking action in this repo (write-off, dispute, archive)
// requires one; rejecting an expense is exactly that kind of judgment call.
export const rejectExpenseSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type RejectExpenseInput = z.infer<typeof rejectExpenseSchema>;

export const markPaidExpenseSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type MarkPaidExpenseInput = z.infer<typeof markPaidExpenseSchema>;

export const listExpensesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
  workflowStatus: z.nativeEnum(ExpenseWorkflowStatus).optional(),
  branchId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  source: z.nativeEnum(ExpenseSource).optional(),
  tagId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;

export const MAX_ATTACHMENT_SIZE = MAX_ATTACHMENT_SIZE_BYTES;
export const MAX_ATTACHMENTS = MAX_ATTACHMENTS_PER_EXPENSE;
export const MAX_TAGS = MAX_TAGS_PER_EXPENSE;
