import { z } from "zod";

// 10MB, mirrors expense.schema.ts's/poNegotiationAttachment.schema.ts's own
// MAX_ATTACHMENT_SIZE_BYTES exactly -- same reused limit.
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

// Unlike PO Negotiation Attachments (where `type` is DERIVED from mimeType,
// since image/pdf/excel/doc/video are file-FORMAT categories), Shipment
// Attachment's `type` classifies WHAT DOCUMENT this is (a packing list vs
// a bill of lading vs a certificate of origin) -- a document ROLE, not a
// file format. The same PDF mimeType could legitimately be any of these
// types, so `type` must be client-chosen here, never derived.
const SHIPMENT_ATTACHMENT_TYPES = [
  "packing_list",
  "bill_of_lading",
  "air_waybill",
  "certificate_of_origin",
  "insurance_certificate",
  "inspection_certificate",
  "other",
] as const;

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

const attachmentBaseSchema = z.object({
  type: z.enum(SHIPMENT_ATTACHMENT_TYPES),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  fileSizeBytes: z.coerce.number().int().positive().max(MAX_ATTACHMENT_SIZE_BYTES),
  storageKey: z.string().trim().min(1).max(500),
});

export const uploadOwnerShipmentAttachmentSchema = attachmentBaseSchema;
export type UploadOwnerShipmentAttachmentInput = z.infer<typeof uploadOwnerShipmentAttachmentSchema>;

export const uploadSupplierShipmentAttachmentSchema = attachmentBaseSchema.extend({
  senderName: z.string().trim().min(1).max(200),
  senderPhone: z.string().trim().min(1).max(30),
});
export type UploadSupplierShipmentAttachmentInput = z.infer<typeof uploadSupplierShipmentAttachmentSchema>;
