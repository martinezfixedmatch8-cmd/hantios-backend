// Batch 4 remediation (HNT2-PO-003 + the extended masking scope confirmed
// during review) -- masks account_number/iban/swift/wallet_address
// wherever they're serialized in a response to a caller without
// reveal_payment_instruction, on BOTH supplier_payment_instructions'
// own fields and po_advance_payments' own *_snapshot copies of them.
// Deliberately explicit about which fields mask, not a generic "any field
// matching a name pattern" scan -- matching this repo's own convention of
// naming things directly rather than relying on magic string matching.
//
// "The reveal endpoint must be the only permitted full-value path" is
// applied literally: masking happens for EVERY role including owner/
// manager on every routine list/detail/creation response -- there is no
// role-based bypass on these two functions. The two dedicated reveal
// endpoints (supplierPaymentInstruction.service.ts /
// poAdvancePayment.service.ts) are the only code paths that ever return
// an unmasked value, and both are gated by requirePermission
// ("reveal_payment_instruction") plus a real audit event.

const MIN_UNMASKED_SUFFIX = 4;
const MASK_PREFIX = "****";

export function maskSensitiveField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value.length <= MIN_UNMASKED_SUFFIX) return MASK_PREFIX;
  return MASK_PREFIX + value.slice(-MIN_UNMASKED_SUFFIX);
}

export interface MaskableInstructionFields {
  account_number: string | null;
  iban: string | null;
  swift: string | null;
  wallet_address: string | null;
}

export function maskInstructionFields<T extends MaskableInstructionFields>(instruction: T): T {
  return {
    ...instruction,
    account_number: maskSensitiveField(instruction.account_number),
    iban: maskSensitiveField(instruction.iban),
    swift: maskSensitiveField(instruction.swift),
    wallet_address: maskSensitiveField(instruction.wallet_address),
  };
}

export interface MaskableAdvancePaymentSnapshotFields {
  account_number_snapshot: string | null;
  iban_snapshot: string | null;
  swift_snapshot: string | null;
  wallet_address_snapshot: string | null;
}

export function maskAdvancePaymentSnapshotFields<T extends MaskableAdvancePaymentSnapshotFields>(payment: T): T {
  return {
    ...payment,
    account_number_snapshot: maskSensitiveField(payment.account_number_snapshot),
    iban_snapshot: maskSensitiveField(payment.iban_snapshot),
    swift_snapshot: maskSensitiveField(payment.swift_snapshot),
    wallet_address_snapshot: maskSensitiveField(payment.wallet_address_snapshot),
  };
}
