import { z } from "zod";

// 10MB, mirrors expense.schema.ts's own MAX_ATTACHMENT_SIZE_BYTES exactly --
// same reused limit, backed by the identical chk_..._file_size_range shape
// (chk_po_negotiation_attachments_file_size_range) at the DB layer.
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_NEGOTIATION_ATTACHMENTS_PER_UPLOAD = 5;

// `type` (PoNegotiationAttachmentType) is DERIVED from mimeType, never a
// separate client-supplied field -- the same "never track one fact two
// ways" principle already applied elsewhere in this schema (Debts dropping
// its own redundant `disputed` boolean, Expenses' recurring architecture).
// A client-supplied `type` disagreeing with its own mimeType would be a
// data-integrity question with no good resolution; deriving it removes the
// possibility entirely.
const MIME_TO_TYPE: Record<string, "image" | "pdf" | "excel" | "doc" | "video"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/heic": "image",
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "excel",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "doc",
  "video/mp4": "video",
  "video/quicktime": "video",
};
const ALLOWED_MIME_TYPES = Object.keys(MIME_TO_TYPE) as [string, ...string[]];

export function mimeTypeToAttachmentType(mimeType: string): "image" | "pdf" | "excel" | "doc" | "video" {
  return MIME_TO_TYPE[mimeType];
}

// Exported so draftProposalSchema (Enhancement #2 -- inline attachments on
// a proposal, one submission rather than a separate call) can reuse the
// identical per-file validation without duplicating it.
export const attachmentBaseSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  fileSizeBytes: z.coerce.number().int().positive().max(MAX_ATTACHMENT_SIZE_BYTES),
  storageKey: z.string().trim().min(1).max(500),
});

// XOR: an attachment belongs to exactly one of a message or a proposal,
// never both (each is a real, non-polymorphic FK -- see the rejected
// polymorphic-attachments alternative) and never neither (an orphaned
// attachment with no parent makes no sense in this domain).
function requireExactlyOneParent(input: { messageId?: string; proposalId?: string }, ctx: z.RefinementCtx) {
  const count = (input.messageId ? 1 : 0) + (input.proposalId ? 1 : 0);
  if (count !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of messageId or proposalId is required",
      path: count === 0 ? ["messageId"] : ["proposalId"],
    });
  }
}

export const uploadOwnerAttachmentSchema = attachmentBaseSchema
  .extend({
    messageId: z.string().uuid().optional(),
    proposalId: z.string().uuid().optional(),
  })
  .superRefine(requireExactlyOneParent);
export type UploadOwnerAttachmentInput = z.infer<typeof uploadOwnerAttachmentSchema>;

export const uploadSupplierAttachmentSchema = attachmentBaseSchema
  .extend({
    messageId: z.string().uuid().optional(),
    proposalId: z.string().uuid().optional(),
    senderName: z.string().trim().min(1).max(200),
    senderPhone: z.string().trim().min(1).max(30),
  })
  .superRefine(requireExactlyOneParent);
export type UploadSupplierAttachmentInput = z.infer<typeof uploadSupplierAttachmentSchema>;
