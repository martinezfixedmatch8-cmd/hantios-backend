import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import type { PaginationQuery } from "../lib/pagination";
import type { CreateSupplierPaymentInstructionInput } from "../validation/supplierPaymentInstruction.schema";

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

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, createSupplierPaymentInstructionEndpoint(supplierId), 201, responseBody);
    return created;
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

  return paginate(rows, total, query.page, query.pageSize);
}

// Unsets the prior default (a no-op update if none existed), then sets the
// target -- the real guard against two concurrent requests both landing a
// default is the partial unique index (ux_supplier_payment_instructions_one_
// default), not this ordering; a lost race surfaces as a clean P2002 caught
// below and converted to a 409, never a silent double-default or a 500.
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

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, setDefaultSupplierPaymentInstructionEndpoint(supplierId, instructionId), 200, responseBody);
    return updated;
  });

  domainEvents.publish("SupplierPaymentInstructionDefaultChanged", {
    businessId: actor.businessId,
    supplierId,
    instructionId: result.id,
  });

  return result;
}
