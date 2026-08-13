import { Prisma, type ReceiptType, type ReceiptStatus } from "@prisma/client";
import { createHash } from "crypto";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { getReplayedResponse, claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { getReceiptSettings } from "../lib/businessSettings";
import { getNextReceiptDocumentNumber } from "../lib/receiptNumberCounter";
import { renderReceiptText, formatIssuedAtLocal, RECEIPT_RENDERER_VERSION } from "../lib/receiptRenderer";
import { resolveListQuery, paginate, type PaginationQuery } from "../lib/pagination";
import { getNotificationProvider } from "../notifications/registry";
import type { ReceiptSnapshot } from "../lib/receiptSnapshot";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Same Neon-latency reasoning as every other transactional service in this repo.
export const RECEIPT_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

// ============================================================================
// Generation -- called from WITHIN an already-open transaction belonging to
// the source event's OWN service function (createSale/refundSale/
// recordPayment/reversePayment/recordWarehouseMovement/
// createGoodsReceivedNote/recordPurchaseOrderPayment), never as a separate
// prisma.$transaction of its own -- mirrors createExpenseInTransaction's
// established precedent exactly ("extracted from createExpense's own
// transaction body... takes tx directly, does no idempotency claim/complete
// and publishes no domain event itself -- both stay the caller's
// responsibility exactly once").
//
// This is also the entire "No Orphan Receipts" guarantee: since receipt
// creation is just one more write inside the source transaction, a later
// rollback of that transaction (for ANY reason) rolls the receipt back too,
// by construction -- there is no separate commit boundary for a receipt to
// outlive its own source event.
//
// Request-level Idempotency-Key protection (Layer 1) is inherited for free
// from whichever endpoint actually triggered this (POST /sales, POST
// /debts/:id/payments, etc.) -- those already claim/replay on their own
// Idempotency-Key before this function is ever reached, so a retried
// source-event request never re-runs this at all. Source-event uniqueness
// (Layer 2 -- at most one receipt per source row) is enforced by the 5
// hand-added partial unique indexes on `receipts` (see the migration) --
// caught below and translated into a clean 409, never a raw P2002 leak.
// ============================================================================

export interface GenerateReceiptSource {
  saleId?: string;
  debtPaymentId?: string;
  warehouseMovementId?: string;
  goodsReceivedNoteId?: string;
  purchaseOrderPaymentId?: string;
  // Module 12 Session A -- 7th source, same sparse-FK treatment as the 5 above.
  payrollRecordId?: string;
}

export interface GenerateReceiptParams {
  businessId: string;
  timezone: string;
  settings: Prisma.JsonValue;
  currencyCode: string;
  receiptType: "sale" | "refund" | "debt_payment" | "warehouse_stock_out" | "supplier_goods_received" | "po_settlement" | "payroll";
  source: GenerateReceiptSource;
  subtotal: Prisma.Decimal.Value;
  discount?: Prisma.Decimal.Value;
  taxAmount?: Prisma.Decimal.Value;
  feeAmount?: Prisma.Decimal.Value;
  total: Prisma.Decimal.Value;
  snapshot: ReceiptSnapshot;
  createdBy: string;
  refundOfReceiptId?: string;
}

export async function generateReceiptInTransaction(tx: Prisma.TransactionClient, params: GenerateReceiptParams) {
  const sourceValues = Object.values(params.source).filter((v) => v !== undefined && v !== null);
  if (sourceValues.length !== 1) {
    // Programmer error, not a client-input error -- every call site is
    // internal (Sale/Debt/Warehouse/GRN/PO-Payment service code), never
    // reachable from a raw HTTP request.
    throw new Error("generateReceiptInTransaction requires exactly one populated source id");
  }

  const { prefix, language } = getReceiptSettings(params.settings);
  const receiptNumber = await getNextReceiptDocumentNumber(tx, params.businessId, params.timezone, prefix);

  try {
    return await tx.receipts.create({
      data: {
        id: generateId(),
        business_id: params.businessId,
        receipt_number: receiptNumber,
        receipt_type: params.receiptType,
        sale_id: params.source.saleId ?? null,
        debt_payment_id: params.source.debtPaymentId ?? null,
        warehouse_movement_id: params.source.warehouseMovementId ?? null,
        goods_received_note_id: params.source.goodsReceivedNoteId ?? null,
        purchase_order_payment_id: params.source.purchaseOrderPaymentId ?? null,
        payroll_record_id: params.source.payrollRecordId ?? null,
        refund_of_receipt_id: params.refundOfReceiptId ?? null,
        business_timezone: params.timezone,
        currency_code: params.currencyCode,
        subtotal: params.subtotal,
        discount: params.discount ?? 0,
        tax_amount: params.taxAmount ?? 0,
        fee_amount: params.feeAmount ?? 0,
        total: params.total,
        language,
        snapshot: params.snapshot as unknown as Prisma.InputJsonValue,
        snapshot_version: 1,
        created_by: params.createdBy,
      },
    });
  } catch (err) {
    // The 5 partial unique indexes (source-event uniqueness) and the
    // (business_id, receipt_number) unique both surface here identically --
    // either way, a genuine duplicate-generation attempt for the same
    // underlying event, translated to a clean, real 409 rather than a raw
    // Prisma P2002 leak. This is the DB-level guarantee the CRITICAL
    // SAFEGUARD exists to prove -- see tests/receipt.test.ts's own
    // concurrency test asserting this path is actually reached.
    const isUniqueViolation = err instanceof Object && "code" in err && (err as { code?: string }).code === "P2002";
    if (isUniqueViolation) {
      throw conflict("A receipt already exists for this source event");
    }
    throw err;
  }
}

// Sale Void creates no new financial row (confirmed Phase 0) -- so no new
// receipt either. This transitions the EXISTING Sale Receipt's own status,
// inside voidSale's own transaction. A no-op (0 rows) is NOT an error --
// covers the case where no receipt exists yet for some reason (e.g. a
// pre-Module-06 sale), matching this repo's general tolerance for
// receipts being additive, never a hard dependency of Sale's own logic.
export async function markSaleReceiptVoided(tx: Prisma.TransactionClient, businessId: string, saleId: string): Promise<void> {
  await tx.receipts.updateMany({
    where: { business_id: businessId, sale_id: saleId, receipt_type: "sale", status: "issued" },
    data: { status: "voided" },
  });
}

// Sale Refund, Partial Refund & Inventory Restoration -- partially_refunded
// is now reachable for real (previously schema-complete but deliberately
// unreachable, same category as ExpenseWorkflowStatus.draft, since Sale's
// own refund logic used to be a full reversal only). The WHERE clause
// matches BOTH `issued` and `partially_refunded` -- a second (or third...)
// partial refund event against the same sale must still be able to
// transition the receipt further (partially_refunded -> partially_refunded,
// or partially_refunded -> the terminal refunded), not silently no-op
// because the receipt already left its original `issued` state.
export async function markSaleReceiptRefunded(tx: Prisma.TransactionClient, businessId: string, saleId: string, fullyRefunded: boolean): Promise<void> {
  await tx.receipts.updateMany({
    where: { business_id: businessId, sale_id: saleId, receipt_type: "sale", status: { in: ["issued", "partially_refunded"] } },
    data: { status: fullyRefunded ? "refunded" : "partially_refunded" },
  });
}

// ============================================================================
// Snapshot builders -- pure functions, one per receipt type, called at each
// trigger's own call site where the relevant data is already in scope.
// ============================================================================

interface BusinessProfileLike {
  name: string;
  settings: Prisma.JsonValue;
}

// Business address/logo are LOCKED-required receipt content, but neither
// exists as a real column on `businesses` today (confirmed: id/name/
// owner_id/plan/tier/country/phone_prefix/timezone/currency/decimal_places/
// language/fiscal_year_*/settings only) -- read defensively from
// settings.businessProfile.{address,logoUrl}, same Tier-3 pattern as every
// other settings-sourced value, defaulting to null. Flagged explicitly:
// this is a real, load-bearing gap most businesses' settings won't have
// populated yet, not a silently invented field.
function getBusinessProfile(settings: Prisma.JsonValue): { address: string | null; logoUrl: string | null } {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return { address: null, logoUrl: null };
  const profile = (settings as Record<string, unknown>).businessProfile;
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return { address: null, logoUrl: null };
  const p = profile as Record<string, unknown>;
  return {
    address: typeof p.address === "string" ? p.address : null,
    logoUrl: typeof p.logoUrl === "string" ? p.logoUrl : null,
  };
}

function baseSnapshotBusiness(business: BusinessProfileLike): ReceiptSnapshot["business"] {
  const profile = getBusinessProfile(business.settings);
  return { name: business.name, address: profile.address, logoUrl: profile.logoUrl };
}

interface SaleLineSnapshotLike {
  productName: string;
  size: string | null;
  quantity: string;
  sellingPriceAtSale: string;
  lineSubtotal: string;
}

export function buildSaleReceiptSnapshot(
  business: BusinessProfileLike,
  items: SaleLineSnapshotLike[],
  paymentMethodName: string | null
): ReceiptSnapshot {
  return {
    business: baseSnapshotBusiness(business),
    items: items.map((i) => ({
      productName: i.productName,
      size: i.size,
      quantity: i.quantity,
      unitPrice: i.sellingPriceAtSale,
      lineTotal: i.lineSubtotal,
    })),
    paymentMethod: paymentMethodName,
  };
}

export function buildRefundReceiptSnapshot(
  business: BusinessProfileLike,
  items: SaleLineSnapshotLike[],
  paymentMethodName: string | null,
  originalReceiptNumber: string
): ReceiptSnapshot {
  return {
    ...buildSaleReceiptSnapshot(business, items, paymentMethodName),
    refund: { originalReceiptNumber },
  };
}

export function buildDebtPaymentReceiptSnapshot(
  business: BusinessProfileLike,
  paymentMethodName: string | null,
  debtContext: { amountOriginal: string; amountPaidTotal: string; remainingBalance: string; isFullPayment: boolean; isReversal: boolean },
  productLine: { description: string }
): ReceiptSnapshot {
  return {
    business: baseSnapshotBusiness(business),
    items: [{ productName: productLine.description, size: null, quantity: "1", unitPrice: debtContext.amountOriginal, lineTotal: debtContext.amountOriginal }],
    paymentMethod: paymentMethodName,
    debtPayment: debtContext,
  };
}

export function buildWarehouseStockOutReceiptSnapshot(
  business: BusinessProfileLike,
  items: ReceiptSnapshot["items"],
  warehouseContext: { warehouseName: string; destinationBranchName: string | null; movementNumber: string }
): ReceiptSnapshot {
  return {
    business: baseSnapshotBusiness(business),
    items,
    paymentMethod: null,
    warehouseStockOut: warehouseContext,
  };
}

export function buildSupplierGoodsReceivedReceiptSnapshot(
  business: BusinessProfileLike,
  items: ReceiptSnapshot["items"],
  grnContext: { supplierName: string; poNumber: string; grnNumber: string }
): ReceiptSnapshot {
  return {
    business: baseSnapshotBusiness(business),
    items,
    paymentMethod: null,
    supplierGoodsReceived: grnContext,
  };
}

export function buildPoSettlementReceiptSnapshot(
  business: BusinessProfileLike,
  paymentMethodName: string | null,
  poContext: { supplierName: string; poNumber: string; matchStatus: string; amount: string }
): ReceiptSnapshot {
  return {
    business: baseSnapshotBusiness(business),
    items: [{ productName: `Payment to ${poContext.supplierName} (${poContext.poNumber})`, size: null, quantity: "1", unitPrice: poContext.amount, lineTotal: poContext.amount }],
    paymentMethod: paymentMethodName,
    poSettlement: { supplierName: poContext.supplierName, poNumber: poContext.poNumber, matchStatus: poContext.matchStatus },
  };
}

// Module 12 Session A -- Payroll Receipt (7th type).
export function buildPayrollReceiptSnapshot(
  business: BusinessProfileLike,
  paymentMethodName: string | null,
  payrollContext: { employeeName: string; position: string | null; periodLabel: string; compensationModel: string; amount: string }
): ReceiptSnapshot {
  return {
    business: baseSnapshotBusiness(business),
    items: [{ productName: `Salary - ${payrollContext.employeeName} (${payrollContext.periodLabel})`, size: null, quantity: "1", unitPrice: payrollContext.amount, lineTotal: payrollContext.amount }],
    paymentMethod: paymentMethodName,
    payroll: {
      employeeName: payrollContext.employeeName,
      position: payrollContext.position,
      periodLabel: payrollContext.periodLabel,
      compensationModel: payrollContext.compensationModel,
    },
  };
}

// ============================================================================
// Read side -- list / get, standard {data, pagination} + reprint (get is
// reprint; a receipt has no separate "reprint" endpoint, it just re-renders
// the same immutable data deterministically, per Rendering Determinism).
// ============================================================================

export interface ListReceiptsQuery extends PaginationQuery {
  type?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function listReceipts(query: ListReceiptsQuery, actor: Actor) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["issued_at", "receipt_number", "total"] as const,
    defaultSort: "issued_at",
    searchableFields: ["receipt_number"],
  });

  const where: Prisma.receiptsWhereInput = {
    business_id: actor.businessId,
    ...(query.type ? { receipt_type: query.type as ReceiptType } : {}),
    ...(query.status ? { status: query.status as ReceiptStatus } : {}),
    ...(query.dateFrom || query.dateTo
      ? { issued_at: { ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}), ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}) } }
      : {}),
    ...(resolved.searchWhere ?? {}),
  };

  const [rows, total] = await Promise.all([
    prisma.receipts.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.receipts.count({ where }),
  ]);

  return paginate(rows, total, resolved.page, resolved.pageSize);
}

export async function getReceipt(id: string, actor: Actor) {
  const receipt = await getOwned(prisma.receipts.findUnique({ where: { id } }), actor.businessId, "Receipt");
  const deliveryAttempts = await prisma.receipt_delivery_attempts.findMany({
    where: { receipt_id: id, business_id: actor.businessId },
    orderBy: { attempt_number: "asc" },
  });
  const snapshot = receipt.snapshot as unknown as ReceiptSnapshot;
  const renderedText = renderReceiptText({
    receiptNumber: receipt.receipt_number,
    receiptType: receipt.receipt_type,
    status: receipt.status,
    issuedAtLocal: formatIssuedAtLocal(receipt.issued_at, receipt.business_timezone),
    currencyCode: receipt.currency_code,
    subtotal: receipt.subtotal.toString(),
    discount: receipt.discount.toString(),
    taxAmount: receipt.tax_amount.toString(),
    feeAmount: receipt.fee_amount.toString(),
    total: receipt.total.toString(),
    language: receipt.language,
    snapshot,
  });
  return { ...receipt, renderedText, rendererVersion: RECEIPT_RENDERER_VERSION, deliveryAttempts };
}

// ============================================================================
// Delivery -- append-only receipt_delivery_attempts, channel-independent,
// its own Idempotency-Key layer (separate from generation's, which is
// inherited from the source endpoint per the header comment above).
//
// Two-layer idempotency, both real, neither purely cosmetic:
//  - TRUE concurrency (two simultaneous requests sharing a never-before-seen
//    key) is guarded by claimIdempotencyKey's own unique constraint on
//    (business_id, key, endpoint) -- claimed as the FIRST write inside the
//    SAME transaction that creates the delivery_attempts row, exactly the
//    same shape every other write endpoint in this repo already uses.
//  - The payload-hash comparison below is an ADDITIONAL, Module-06-local
//    semantic check on top of that shared primitive (confirmed: a local
//    addition, not a change to src/lib/idempotency.ts itself, which has no
//    payload-hash concept for any of its other 40+ consumers -- see
//    CLAUDE.md's own hardening-backlog note). It distinguishes an
//    accidental double-click (same key, same {channel} payload -> replay
//    the original result) from a genuine "Send Again" click (a fresh
//    client-generated key -> a new attempt) -- and rejects the one case
//    neither the shared primitive nor a naive replay would catch: the SAME
//    key reused with a DIFFERENT payload.
// ============================================================================

function hashDeliveryPayload(payload: { channel: string }): string {
  return createHash("sha256").update(JSON.stringify({ channel: payload.channel })).digest("hex");
}

export function requestReceiptDeliveryEndpoint(receiptId: string): string {
  return `POST /receipts/${receiptId}/deliver`;
}

export interface DeliveryReplayResult {
  status: number;
  body: unknown;
}

// Called by the controller BEFORE the service function -- mirrors this
// repo's universal getReplayedResponse-in-the-controller shape, with one
// addition: payload-hash comparison. Returns null to mean "proceed
// normally" (no prior claim -- including the mid-flight "already being
// processed" case, which getReplayedResponse itself already throws 409 for,
// unchanged), a replay body to mean "return this unchanged," or throws 409
// for a genuine same-key/different-payload reuse.
export async function checkDeliveryIdempotentReplay(
  businessId: string,
  key: string,
  receiptId: string,
  payload: { channel: string }
): Promise<DeliveryReplayResult | null> {
  const replayed = await getReplayedResponse(businessId, key, requestReceiptDeliveryEndpoint(receiptId));
  if (!replayed) return null;
  const body = replayed.body as { data?: unknown; _payloadHash?: string };
  const freshHash = hashDeliveryPayload(payload);
  if (body._payloadHash !== undefined && body._payloadHash !== freshHash) {
    throw conflict("Idempotency-Key was already used with a different delivery request");
  }
  return { status: replayed.status, body: body.data ?? body };
}

export interface RequestDeliveryInput {
  channel: "whatsapp" | "pos_print";
}

export async function requestReceiptDelivery(receiptId: string, input: RequestDeliveryInput, actor: Actor, idempotencyKey: string) {
  const receipt = await getOwned(prisma.receipts.findUnique({ where: { id: receiptId } }), actor.businessId, "Receipt");

  // Recipient resolution BEFORE the transaction -- channel-specific, per
  // the locked Delivery-Attempt Recipient Semantics (never one shape forced
  // onto both channels).
  let customerId: string | null = null;
  let employeeId: string | null = null;
  let phoneSnapshot: string | null = null;
  let branchId: string | null = null;

  if (input.channel === "whatsapp") {
    if (receipt.sale_id) {
      const sale = await prisma.sales.findUnique({ where: { id: receipt.sale_id } });
      customerId = sale?.customer_id ?? null;
      phoneSnapshot = sale?.customer_phone ?? null;
    } else if (receipt.debt_payment_id) {
      const payment = await prisma.debt_payments.findUnique({ where: { id: receipt.debt_payment_id }, include: { debts: true } });
      customerId = payment?.debts.customer_id ?? null;
      phoneSnapshot = payment?.debts.customer_phone ?? null;
    } else if (receipt.payroll_record_id) {
      // Module 12 Session A -- the real recipient here is an Employee, never
      // a Customer. Snapshotted at attempt time, same reasoning as every
      // other channel-specific recipient in this table: a later phone
      // number edit on the Employee record must never rewrite what a
      // historical delivery attempt says it sent to.
      const payrollRecord = await prisma.payroll_records.findUnique({ where: { id: receipt.payroll_record_id }, include: { employees: true } });
      employeeId = payrollRecord?.employees.id ?? null;
      phoneSnapshot = payrollRecord?.employees.phone ?? null;
    }
    if (!phoneSnapshot) {
      throw badRequest("No phone number is available for this receipt -- cannot deliver via WhatsApp");
    }
  } else {
    branchId = actor.userId ? (await prisma.users.findUnique({ where: { id: actor.userId } }))?.branch_id ?? null : null;
  }

  const attempt = await prisma.$transaction(async (tx) => {
    // Real claim, first write -- the actual guard against true concurrent
    // duplicate requests sharing this exact key (a stale/mismatched-payload
    // retry is handled separately, above, before this function is ever
    // reached).
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, requestReceiptDeliveryEndpoint(receiptId));

    const attemptCount = await tx.receipt_delivery_attempts.count({ where: { receipt_id: receiptId } });
    let attemptNumber = attemptCount + 1;

    let created;
    // The @@unique([receipt_id, attempt_number]) guard on retry -- delivery
    // attempts are low-contention (a human clicking a button, not a
    // high-frequency financial write path), so a simple count+retry-once is
    // proportionate; the claim above is what actually protects against a
    // true same-key race, this loop only guards against the vanishingly
    // rare case of two DIFFERENT keys computing the same attempt_number.
    for (let tries = 0; tries < 3; tries++) {
      try {
        created = await tx.receipt_delivery_attempts.create({
          data: {
            id: generateId(),
            business_id: actor.businessId,
            receipt_id: receiptId,
            attempt_number: attemptNumber,
            channel: input.channel,
            status: "pending",
            requested_by: actor.userId,
            customer_id: customerId,
            employee_id: employeeId,
            phone_snapshot: phoneSnapshot,
            branch_id: branchId,
          },
        });
        break;
      } catch (err) {
        const isUniqueViolation = err instanceof Object && "code" in err && (err as { code?: string }).code === "P2002";
        if (!isUniqueViolation) throw err;
        attemptNumber += 1;
      }
    }
    if (!created) throw conflict("Could not allocate a delivery attempt slot, please retry");
    return created;
  }, RECEIPT_TRANSACTION_OPTIONS);

  domainEvents.publish("ReceiptDeliveryRequested", {
    businessId: actor.businessId,
    receiptId,
    attemptId: attempt.id,
    channel: input.channel,
  });

  // Real send (WhatsApp) or a pure formatted-response return (POS_PRINT --
  // "a formatted response a frontend POS client sends to a printer, not
  // this backend owning printer-hardware communication," so a POS_PRINT
  // attempt succeeds the instant rendering succeeds, no external I/O).
  // Non-blocking relative to the attempt's own creation, but awaited here
  // (not fire-and-forget) since the client needs to know the real outcome
  // to decide whether to retry -- unlike a background notification, this
  // IS the primary purpose of the call.
  const snapshot = receipt.snapshot as unknown as ReceiptSnapshot;
  const renderedText = renderReceiptText({
    receiptNumber: receipt.receipt_number,
    receiptType: receipt.receipt_type,
    status: receipt.status,
    issuedAtLocal: formatIssuedAtLocal(receipt.issued_at, receipt.business_timezone),
    currencyCode: receipt.currency_code,
    subtotal: receipt.subtotal.toString(),
    discount: receipt.discount.toString(),
    taxAmount: receipt.tax_amount.toString(),
    feeAmount: receipt.fee_amount.toString(),
    total: receipt.total.toString(),
    language: receipt.language,
    snapshot,
  });

  let finalStatus: "success" | "failed" = "success";
  let failureReason: string | null = null;

  if (input.channel === "whatsapp") {
    try {
      await getNotificationProvider().send({
        category: "TRANSACTIONAL",
        channel: "whatsapp",
        to: phoneSnapshot as string,
        businessId: actor.businessId,
        body: renderedText,
      });
    } catch (err) {
      finalStatus = "failed";
      failureReason = err instanceof Error ? err.message : "Unknown notification error";
    }
  }

  const completed = await prisma.receipt_delivery_attempts.update({
    where: { id: attempt.id },
    data: { status: finalStatus, completed_at: new Date(), failure_reason: failureReason },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: finalStatus === "success" ? "receipt.delivery_succeeded" : "receipt.delivery_failed",
    entityType: "receipt",
    entityId: receiptId,
    reason: `Delivery attempt #${attempt.attempt_number} via ${input.channel}: ${finalStatus}${failureReason ? ` (${failureReason})` : ""}`,
  });

  domainEvents.publish(finalStatus === "success" ? "ReceiptDeliverySucceeded" : "ReceiptDeliveryFailed", {
    businessId: actor.businessId,
    receiptId,
    attemptId: attempt.id,
    channel: input.channel,
  });

  return { ...completed, _payloadHash: hashDeliveryPayload(input), receiptRenderedText: renderedText };
}

export async function completeDeliveryIdempotencyKey(businessId: string, key: string, receiptId: string, status: number, resultWithHash: unknown) {
  await prisma.$transaction(async (tx) => {
    await completeIdempotencyKey(tx, businessId, key, requestReceiptDeliveryEndpoint(receiptId), status, resultWithHash);
  });
}

export async function listDeliveryAttempts(receiptId: string, actor: Actor) {
  await getOwned(prisma.receipts.findUnique({ where: { id: receiptId } }), actor.businessId, "Receipt");
  return prisma.receipt_delivery_attempts.findMany({
    where: { receipt_id: receiptId, business_id: actor.businessId },
    orderBy: { attempt_number: "asc" },
  });
}
