import { z } from "zod";
import { getCurrency } from "../lib/currencyReference";

const WALLET_NETWORKS = ["trc20", "erc20"] as const;

// Requirement: at least one of iban/accountNumber/walletAddress must be
// present (a payment instruction with none of these is meaningless, nowhere
// to actually send money) -- mirrored at the app layer here for a clean
// 400, backed for real by the DB's own
// chk_supplier_payment_instructions_has_target CHECK constraint. network
// only valid alongside walletAddress, same dual app+DB enforcement.
function validateInstructionTarget(
  input: { iban?: string; accountNumber?: string; walletAddress?: string; network?: string },
  ctx: z.RefinementCtx
) {
  if (!input.iban && !input.accountNumber && !input.walletAddress) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one of iban, accountNumber, or walletAddress is required",
      path: ["iban"],
    });
  }
  if (input.network && !input.walletAddress) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "network is only valid alongside a walletAddress", path: ["network"] });
  }
}

export const createSupplierPaymentInstructionSchema = z
  .object({
    beneficiaryName: z.string().trim().min(1).max(200),
    bankName: z.string().trim().min(1).max(200).optional(),
    accountNumber: z.string().trim().min(1).max(100).optional(),
    iban: z.string().trim().min(1).max(50).optional(),
    swift: z.string().trim().min(1).max(20).optional(),
    walletAddress: z.string().trim().min(1).max(200).optional(),
    network: z.enum(WALLET_NETWORKS).optional(),
    defaultCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .refine((code) => getCurrency(code) !== undefined, { message: "defaultCurrency must be a valid ISO 4217 currency code" }),
    // Batch 4 remediation (HNT2-PO-003) -- optional; no expiry means never
    // expires. Business-local, inclusive-through semantics -- see
    // poAdvancePayment.service.ts's own expiry check for the exact
    // date-comparison technique reused from isOverdue.
    expiryDate: z.coerce.date().optional(),
  })
  .superRefine(validateInstructionTarget);
export type CreateSupplierPaymentInstructionInput = z.infer<typeof createSupplierPaymentInstructionSchema>;

export const setDefaultSupplierPaymentInstructionSchema = z.object({});
export type SetDefaultSupplierPaymentInstructionInput = z.infer<typeof setDefaultSupplierPaymentInstructionSchema>;

// Batch 4 remediation (HNT2-PO-003) -- matches Suppliers' own archive/
// restore precedent exactly: archive requires a reason, restore doesn't.
// Revoke requires one too (a stricter, permanent action deserves at least
// the same bar as archive).
export const archiveSupplierPaymentInstructionSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type ArchiveSupplierPaymentInstructionInput = z.infer<typeof archiveSupplierPaymentInstructionSchema>;

export const restoreSupplierPaymentInstructionSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type RestoreSupplierPaymentInstructionInput = z.infer<typeof restoreSupplierPaymentInstructionSchema>;

export const revokeSupplierPaymentInstructionSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type RevokeSupplierPaymentInstructionInput = z.infer<typeof revokeSupplierPaymentInstructionSchema>;
