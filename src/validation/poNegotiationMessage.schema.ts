import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

export const createOwnerMessageSchema = z.object({
  messageText: z.string().trim().min(1).max(2000),
  replyToMessageId: z.string().uuid().optional(),
});
export type CreateOwnerMessageInput = z.infer<typeof createOwnerMessageSchema>;

// Supplier has no user account -- name/phone captured at send time, same
// reasoning throughout this whole module. Phone is normalized via the
// existing libphonenumber-js helper (src/lib/phoneNormalization.ts) at the
// service layer, not here (normalization needs business.country).
export const createSupplierMessageSchema = z.object({
  senderName: z.string().trim().min(1).max(200),
  senderPhone: z.string().trim().min(1).max(30),
  messageText: z.string().trim().min(1).max(2000),
  replyToMessageId: z.string().uuid().optional(),
});
export type CreateSupplierMessageInput = z.infer<typeof createSupplierMessageSchema>;

export const listMessagesQuerySchema = paginationQuerySchema;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
