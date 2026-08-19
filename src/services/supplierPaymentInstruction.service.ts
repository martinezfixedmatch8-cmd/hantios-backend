import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { maskInstructionFields } from "../lib/paymentInstructionMasking";
import type { PaginationQuery } from "../lib/pagination";
import type {
  CreateSupplierPaymentInstructionInput,
  ArchiveSupplierPaymentInstructionInput,
  RestoreSupplierPaymentInstructionInput,
  RevokeSupplierPaymentInstructionInput,
} from "../validation/supplierPaymentInstruction.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export function createSupplierPaymentInstructionEndpoint(supplierId: string): string {
  return `POST /suppliers/${supplierId}/payment-instructions`;
}
export function setDefaultSupplierPaymentInstructionEndpoint(supplierId: string, instructionId: string): string {
  return `POST /suppliers/${supplierId}/payment-instructions/${instructionId}/set-default`;
}
export function archiveSupplierPaymentInstructionEndpoint(supplierId: string, instructionId: string): string {
  return `POST /suppliers/${supplierId}/payment-instructions/${instructionId}/archive`;
}
export function restoreSupplierPaymentInstructionEndpoint(supplierId: string, instructionId: string): string {
  return `POST /suppliers/${supplierId}/payment-instructions/${instructionId}/restore`;
}
export function revokeSupplierPaymentInstructionEndpoint(supplierId: string, instructionId: string): string {
  return `POST /suppliers/${supplierId}/payment-instructions/${instructionId}/revoke`;
}

async function assertActiveSupplier(supplierId: string, businessId: string) {
  const supplier = await getOwned(prisma.suppliers.findUnique({ where: { id: supplierId } }), businessId, "Supplier");
  if (supplier.status !== "active") throw badRequest("Cannot manage payment instructions for an archived supplier");
  return supplier;
}

// A supplier can have multiple payment instructions (e.g. a bank account AND
// a USDT wallet) -- create never requires the caller to pick isDefault
// explicitly. Interpretation, flagged: a supplier's very FIRST instruction
// auto-becomes the default (otherwise a supplier with exactly one
// instruction and no explicit set-default call would have none marked
// default at all, which serves no one) -- every subsequent instruction
// defaults to false until the owner explicitly promotes it via set-default.
export async function createSupplierPaymentInstruction(
  supplierId: string,
  input: CreateSupplierPaymentInstructionInput,
  actor: Actor,
  idempotencyKey: string
) {
  await assertActiveSupplier(supplierId, actor.businessId);

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, createSupplierPaymentInstructionEndpoint(supplierId));

    const existingCount = await tx.supplier_payment_instructions.count({ where: { supplier_id: supplierId } });

    const created = await tx.supplier_payment_instructions.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        supplier_id: supplierId,
        beneficiary_name: input.beneficiaryName,
        bank_name: input.bankName ?? null,
        account_number: input.accountNumber ?? null,
        iban: input.iban ?? null,
        swift: input.swift ?? null,
        wallet_address: input.walletAddress ?? null,
        network: input.network ?? null,
        default_currency: input.defaultCurrency,
        expiry_date: input.expiryDate ?? null,
        is_default: existingCount === 0,
        created_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "supplier_payment_instruction.created",
      entityType: "supplier_payment_instruction",
      entityId: created.id,
      reason: `Payment instruction "${created.beneficiary_name}" added for supplier`,
    });

    // Batch 4 remediation -- masked BEFORE the idempotency response body is
    // constructed, so a later replay of this exact key returns the
    // already-masked body too, never a fresh leak on retry. "The reveal
    // endpoint is the only permitted full-value path" applies uniformly,
    // including to the creator's own response, per the confirmed policy.
    const masked = maskInstructionFields(created);
    const responseBody = JSON.parse(JSON.stringify({ data: masked })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, createSupplierPaymentInstructionEndpoint(supplierId), 201, responseBody);
    return masked;
  });

  domainEvents.publish("SupplierPaymentInstructionCreated", {
    businessId: actor.businessId,
    supplierId,
    instructionId: result.id,
    isDefault: result.is_default,
  });

  return result;
}

export async function listSupplierPaymentInstructions(supplierId: string, query: PaginationQuery, businessId: string) {
  await getOwned(prisma.suppliers.findUnique({ where: { id: supplierId } }), businessId, "Supplier");

  const resolved = resolveListQuery(query, { sortableFields: ["created_at"] as const, defaultSort: "created_at" as const });
  const where = { business_id: businessId, supplier_id: supplierId };
  const [rows, total] = await Promise.all([
    prisma.supplier_payment_instructions.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.supplier_payment_instructions.count({ where }),
  ]);

  return paginate(rows.map(maskInstructionFields), total, query.page, query.pageSize);
}

// Unsets the prior default (a no-op update if none existed), then sets the
// target -- the real guard against two concurrent requests both landing a
// default is the partial unique index (ux_supplier_payment_instructions_one_
// default), not this ordering; a lost race surfaces as a clean P2002 caught
// below and converted to a 409, never a silent double-default or a 500.
// Deliberately unscoped by status on the unset step -- clears is_default on
// ANY row that happens to still carry it (active, archived, or, as a second
// layer of defense beyond revoke's own atomic clear, even a revoked one),
// never assuming only active rows could ever be marked default.
export async function setDefaultSupplierPaymentInstruction(
  supplierId: string,
  instructionId: string,
  actor: Actor,
  idempotencyKey: string
) {
  await assertActiveSupplier(supplierId, actor.businessId);
  const instruction = await getOwned(
    prisma.supplier_payment_instructions.findUnique({ where: { id: instructionId } }),
    actor.businessId,
    "Payment instruction"
  );
  if (instruction.supplier_id !== supplierId) throw badRequest("Payment instruction does not belong to this supplier");
  // Batch 4 remediation (HNT2-PO-003) -- setting a new default must never
  // reactivate a revoked (or archived) instruction. Checked before the
  // transaction, matching this repo's "JS pre-check + atomic guard" bar
  // for the common non-concurrent case -- the atomic guard itself is the
  // partial unique index, unrelated to this status check.
  if (instruction.status !== "active") {
    throw badRequest(`Cannot set a ${instruction.status} payment instruction as default`);
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, setDefaultSupplierPaymentInstructionEndpoint(supplierId, instructionId));

    await tx.supplier_payment_instructions.updateMany({
      where: { supplier_id: supplierId, is_default: true },
      data: { is_default: false },
    });

    let updated;
    try {
      updated = await tx.supplier_payment_instructions.update({ where: { id: instructionId }, data: { is_default: true } });
    } catch (err) {
      const isUniqueViolation = err instanceof Object && "code" in err && (err as { code?: string }).code === "P2002";
      if (isUniqueViolation) throw conflict("Another payment instruction was set as default concurrently, please retry");
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "supplier_payment_instruction.default_changed",
      entityType: "supplier_payment_instruction",
      entityId: instructionId,
      reason: `Payment instruction "${updated.beneficiary_name}" set as default`,
    });

    const masked = maskInstructionFields(updated);
    const responseBody = JSON.parse(JSON.stringify({ data: masked })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, setDefaultSupplierPaymentInstructionEndpoint(supplierId, instructionId), 200, responseBody);
    return masked;
  });

  domainEvents.publish("SupplierPaymentInstructionDefaultChanged", {
    businessId: actor.businessId,
    supplierId,
    instructionId: result.id,
  });

  return result;
}

// Batch 4 remediation (HNT2-PO-003) -- restorable round-trip, matching this
// repo's own dominant Branches/PaymentMethods/Suppliers archive/restore
// precedent exactly. Deliberately does NOT touch is_default -- an archived
// instruction that happened to be the default simply stops being
// selectable for new payments (the active-only check in
// poAdvancePayment.service.ts enforces that), but its own is_default flag
// is left as-is; restoring it later returns it to exactly the state it was
// in before archiving, no surprise side effects.
export async function archiveSupplierPaymentInstruction(
  supplierId: string,
  instructionId: string,
  input: ArchiveSupplierPaymentInstructionInput,
  actor: Actor,
  idempotencyKey: string
) {
  const instruction = await getOwned(
    prisma.supplier_payment_instructions.findUnique({ where: { id: instructionId } }),
    actor.businessId,
    "Payment instruction"
  );
  if (instruction.supplier_id !== supplierId) throw badRequest("Payment instruction does not belong to this supplier");
  if (instruction.status !== "active") {
    throw badRequest(`Cannot archive a payment instruction that is already ${instruction.status}`);
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveSupplierPaymentInstructionEndpoint(supplierId, instructionId));

    const guarded = await tx.supplier_payment_instructions.updateMany({
      where: { id: instructionId, business_id: actor.businessId, version: input.version, status: "active" },
      data: { status: "archived", archived_at: new Date(), archived_by: actor.userId, version: { increment: 1 } },
    });
    if (guarded.count === 0) {
      throw conflict("Payment instruction was modified concurrently, please retry with the latest version");
    }
    const updated = await tx.supplier_payment_instructions.findUniqueOrThrow({ where: { id: instructionId } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "supplier_payment_instruction.archived",
      entityType: "supplier_payment_instruction",
      entityId: instructionId,
      reason: input.reason,
    });

    const masked = maskInstructionFields(updated);
    const responseBody = JSON.parse(JSON.stringify({ data: masked })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveSupplierPaymentInstructionEndpoint(supplierId, instructionId), 200, responseBody);
    return masked;
  });

  domainEvents.publish("SupplierPaymentInstructionArchived", { businessId: actor.businessId, supplierId, instructionId: result.id });

  return result;
}

// Only reachable from "archived" -- a revoked instruction can NEVER be
// restored (confirmed policy, permanent by design). This is enforced
// structurally by the atomic guard's own WHERE clause (status: "archived"),
// not just a pre-check -- attempting to restore a revoked row fails the
// SAME way a concurrently-modified row would, a clean 409/400 either way,
// never a silent reactivation.
export async function restoreSupplierPaymentInstruction(
  supplierId: string,
  instructionId: string,
  input: RestoreSupplierPaymentInstructionInput,
  actor: Actor,
  idempotencyKey: string
) {
  const instruction = await getOwned(
    prisma.supplier_payment_instructions.findUnique({ where: { id: instructionId } }),
    actor.businessId,
    "Payment instruction"
  );
  if (instruction.supplier_id !== supplierId) throw badRequest("Payment instruction does not belong to this supplier");
  if (instruction.status === "revoked") {
    throw badRequest("A revoked payment instruction can never be restored -- create a new instruction instead");
  }
  if (instruction.status !== "archived") {
    throw badRequest(`Cannot restore a payment instruction that is already ${instruction.status}`);
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreSupplierPaymentInstructionEndpoint(supplierId, instructionId));

    const guarded = await tx.supplier_payment_instructions.updateMany({
      where: { id: instructionId, business_id: actor.businessId, version: input.version, status: "archived" },
      data: { status: "active", archived_at: null, archived_by: null, version: { increment: 1 } },
    });
    if (guarded.count === 0) {
      throw conflict("Payment instruction was modified concurrently, please retry with the latest version");
    }
    const updated = await tx.supplier_payment_instructions.findUniqueOrThrow({ where: { id: instructionId } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "supplier_payment_instruction.restored",
      entityType: "supplier_payment_instruction",
      entityId: instructionId,
      reason: "Payment instruction restored from archived",
    });

    const masked = maskInstructionFields(updated);
    const responseBody = JSON.parse(JSON.stringify({ data: masked })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, restoreSupplierPaymentInstructionEndpoint(supplierId, instructionId), 200, responseBody);
    return masked;
  });

  domainEvents.publish("SupplierPaymentInstructionRestored", { businessId: actor.businessId, supplierId, instructionId: result.id });

  return result;
}

// Batch 4 remediation (HNT2-PO-003) -- one-way terminal state, reachable
// from active OR archived (a bad instruction might already be archived
// when someone realizes it needs to be marked permanently unsafe).
// Clears is_default in the SAME atomic statement as the status transition
// -- there is no window where the row is revoked but still marked
// default (the confirmed "atomic revoke-current-default" behavior).
export async function revokeSupplierPaymentInstruction(
  supplierId: string,
  instructionId: string,
  input: RevokeSupplierPaymentInstructionInput,
  actor: Actor,
  idempotencyKey: string
) {
  const instruction = await getOwned(
    prisma.supplier_payment_instructions.findUnique({ where: { id: instructionId } }),
    actor.businessId,
    "Payment instruction"
  );
  if (instruction.supplier_id !== supplierId) throw badRequest("Payment instruction does not belong to this supplier");
  if (instruction.status === "revoked") {
    throw badRequest("Payment instruction is already revoked");
  }

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, revokeSupplierPaymentInstructionEndpoint(supplierId, instructionId));

    const guarded = await tx.supplier_payment_instructions.updateMany({
      where: { id: instructionId, business_id: actor.businessId, version: input.version, status: { not: "revoked" } },
      data: {
        status: "revoked",
        revoked_at: new Date(),
        revoked_by: actor.userId,
        is_default: false,
        version: { increment: 1 },
      },
    });
    if (guarded.count === 0) {
      throw conflict("Payment instruction was modified concurrently, please retry with the latest version");
    }
    const updated = await tx.supplier_payment_instructions.findUniqueOrThrow({ where: { id: instructionId } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "supplier_payment_instruction.revoked",
      entityType: "supplier_payment_instruction",
      entityId: instructionId,
      reason: input.reason,
    });

    const masked = maskInstructionFields(updated);
    const responseBody = JSON.parse(JSON.stringify({ data: masked })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, revokeSupplierPaymentInstructionEndpoint(supplierId, instructionId), 200, responseBody);
    return masked;
  });

  domainEvents.publish("SupplierPaymentInstructionRevoked", { businessId: actor.businessId, supplierId, instructionId: result.id });

  return result;
}

// Batch 4 remediation -- the ONLY code path that ever returns an unmasked
// payment instruction. requirePermission("reveal_payment_instruction")
// gates the route; this function additionally writes exactly one audit
// event per call (never per routine list/detail read), containing every
// field the confirmed policy names -- actor, business, instruction id,
// timestamp (audit_logs.created_at), role/permission (in after_state),
// correlation id (a fresh generateId() per call, stored in audit_logs'
// own pre-existing correlation_id column), and which fields were revealed.
// The full sensitive values themselves are NEVER written into the audit
// row or logged anywhere -- only the fact that a reveal happened.
export async function revealSupplierPaymentInstruction(supplierId: string, instructionId: string, actor: Actor) {
  const instruction = await getOwned(
    prisma.supplier_payment_instructions.findUnique({ where: { id: instructionId } }),
    actor.businessId,
    "Payment instruction"
  );
  if (instruction.supplier_id !== supplierId) throw badRequest("Payment instruction does not belong to this supplier");

  const correlationId = generateId();
  const fieldsRevealed = (["account_number", "iban", "swift", "wallet_address"] as const).filter(
    (field) => instruction[field] !== null
  );

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "supplier_payment_instruction.sensitive_data_revealed",
    entityType: "supplier_payment_instruction",
    entityId: instructionId,
    reason: `Full payment instruction details revealed for "${instruction.beneficiary_name}"`,
    correlationId,
    afterState: { permission: "reveal_payment_instruction", fieldsRevealed },
  });

  return instruction;
}
