import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest, conflict, forbidden } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { getNextReceiptNumber } from "../lib/receiptNumber";
import { isSameBusinessDay, getBusinessLocalYear, getBusinessLocalMonth } from "../lib/businessTime";
import { normalizeSize } from "../lib/branchInventory";
import { domainEvents } from "../lib/events";
import {
  generateReceiptInTransaction,
  buildSaleReceiptSnapshot,
  buildRefundReceiptSnapshot,
  markSaleReceiptVoided,
  markSaleReceiptRefunded,
} from "./receipt.service";
import { applyStockAlertTransition } from "../lib/stockAlerts";
import type { PendingStockAlertEvent } from "../lib/stockAlerts";
import { findOrCreateCustomer } from "./customer.service";
import type {
  CreateSaleInput,
  ListSalesQuery,
  VoidSaleInput,
  RefundSaleInput,
  RefundSaleLineInput,
  SetSaleAttributionInput,
  ListSaleRefundsQuery,
} from "../validation/sale.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Prisma's default interactive-transaction timeout (5s) is too tight for this
// module specifically: getNextReceiptNumber's atomic per-(business,year) counter
// row is a deliberate, unavoidable serialization point (that's what "atomic
// sequential numbering" requires -- see receiptNumber.ts), and every round trip
// goes over Neon's serverless HTTP driver, not a persistent local connection.
// Under genuine concurrent load, a transaction queued behind several others
// waiting on that same row can legitimately take longer than 5s to complete
// even though nothing is actually stuck -- confirmed by reproducing a real
// P2028 timeout under 5 truly-concurrent sale creations before raising this.
const SALE_TRANSACTION_OPTIONS = { timeout: 15000 };

// Logical endpoint names for the idempotency_keys unique constraint -- stable
// even if the actual route path ever changes. Void/Refund include the sale id
// so a reused key can never cross-contaminate a different sale's operation.
export const CREATE_SALE_ENDPOINT = "POST /sales";
export const voidSaleEndpoint = (saleId: string): string => `POST /sales/${saleId}/void`;
export const refundSaleEndpoint = (saleId: string): string => `POST /sales/${saleId}/refund`;
export const setSaleAttributionEndpoint = (saleId: string): string => `POST /sales/${saleId}/attribution`;

interface SaleLineSnapshot {
  productId: string;
  productName: string;
  size: string | null;
  quantity: string;
  sellingPriceAtSale: string;
  costPriceAtSale: string;
  lineSubtotal: string;
  discount: string;
  tax: string;
  profit: string;
}

export async function createSale(input: CreateSaleInput, actor: Actor, idempotencyKey: string) {
  const branch = await getOwned(prisma.branches.findUnique({ where: { id: input.branchId } }), actor.businessId, "Branch");
  if (branch.status !== "active") {
    throw badRequest("Branch is archived");
  }

  let paymentMethodName: string | null = null;
  if (input.paymentMethodId) {
    const paymentMethod = await getOwned(
      prisma.payment_methods.findUnique({ where: { id: input.paymentMethodId } }),
      actor.businessId,
      "Payment method"
    );
    if (paymentMethod.status !== "active") {
      throw badRequest("Payment method is archived");
    }
    paymentMethodName = paymentMethod.name;
  }

  // Module 12 Session C -- validated the same way every other optional FK
  // on Sale creation already is (getOwned, cross-business -> 404).
  if (input.salespersonEmployeeId) {
    await getOwned(prisma.employees.findUnique({ where: { id: input.salespersonEmployeeId } }), actor.businessId, "Employee");
  }

  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });

  // Batch-fetch every referenced product in one query -- avoids re-fetching
  // cost_price per line item (documented N+1 fix, see CLAUDE.md).
  const productIds = [...new Set(input.items.map((line) => line.productId))];
  const products = await prisma.products.findMany({ where: { id: { in: productIds }, business_id: actor.businessId } });
  const productMap = new Map(products.map((p) => [p.id, p]));

  // Reject the whole sale on the first failing line -- no partial validation.
  for (const line of input.items) {
    const product = productMap.get(line.productId);
    if (!product) {
      throw badRequest(`Product ${line.productId} was not found`);
    }
    if (product.status !== "active") {
      throw badRequest(`Product "${product.name}" is archived`);
    }
    if (!product.selling_price.greaterThan(0)) {
      throw badRequest(`Product "${product.name}" has no valid selling price`);
    }
  }

  // Each line's subtotal is rounded to 2dp immediately, at the one point it's
  // first computed, and that same rounded value is used everywhere downstream
  // (summed for the sale-level subtotal, used as the discount/tax proration
  // base, and stored in the line's own snapshot). A raw-then-round-later split
  // (sum unrounded values, round once for the sale total, separately round each
  // line for its snapshot) can disagree by a cent -- e.g. two lines each with a
  // raw subtotal of 0.005 independently round up to 0.01 (sum 0.02), while the
  // unrounded total 0.005+0.005=0.010 rounds to 0.01 once. Rounding once, per
  // line, up front makes the sale-level subtotal exactly the sum of the stored
  // line snapshots by construction, not by coincidence.
  const lineSubtotals = input.items.map((line) =>
    productMap.get(line.productId)!.selling_price.times(line.quantity).toDecimalPlaces(2)
  );
  const subtotal = lineSubtotals.reduce((sum, v) => sum.plus(v), new Prisma.Decimal(0));

  let discountAmount = new Prisma.Decimal(0);
  if (input.discount) {
    discountAmount = (
      input.discount.type === "fixed"
        ? new Prisma.Decimal(input.discount.value)
        : subtotal.times(input.discount.value).dividedBy(100)
    ).toDecimalPlaces(2);
    if (discountAmount.greaterThan(subtotal)) {
      throw badRequest("Discount cannot exceed the sale subtotal");
    }
  }

  const taxableBase = subtotal.minus(discountAmount);
  const taxAmount = input.taxRate
    ? taxableBase.times(input.taxRate).dividedBy(100).toDecimalPlaces(2)
    : new Prisma.Decimal(0);
  const total = taxableBase.plus(taxAmount);

  // Prorate discount/tax across lines by each line's share of subtotal, with the
  // rounding remainder assigned to the last line so per-line amounts always sum
  // exactly to the sale-level totals (Requirement #4/#5 -- price snapshot per line,
  // server-computed, no drift between the sum of lines and the sale total).
  const items: SaleLineSnapshot[] = [];
  let allocatedDiscount = new Prisma.Decimal(0);
  let allocatedTax = new Prisma.Decimal(0);
  let totalProfit = new Prisma.Decimal(0);

  input.items.forEach((line, index) => {
    const product = productMap.get(line.productId)!;
    const lineSubtotal = lineSubtotals[index];
    const isLast = index === input.items.length - 1;
    const share = subtotal.greaterThan(0) ? lineSubtotals[index].dividedBy(subtotal) : new Prisma.Decimal(0);

    const lineDiscount = isLast ? discountAmount.minus(allocatedDiscount) : discountAmount.times(share).toDecimalPlaces(2);
    const lineTax = isLast ? taxAmount.minus(allocatedTax) : taxAmount.times(share).toDecimalPlaces(2);
    allocatedDiscount = allocatedDiscount.plus(lineDiscount);
    allocatedTax = allocatedTax.plus(lineTax);

    const lineCost = product.cost_price.times(line.quantity);
    const lineProfit = lineSubtotal.minus(lineDiscount).minus(lineCost).toDecimalPlaces(2);
    totalProfit = totalProfit.plus(lineProfit);

    items.push({
      productId: product.id,
      productName: product.name,
      size: line.size ?? null,
      quantity: line.quantity.toString(),
      sellingPriceAtSale: product.selling_price.toString(),
      costPriceAtSale: product.cost_price.toString(),
      lineSubtotal: lineSubtotal.toString(),
      discount: lineDiscount.toString(),
      tax: lineTax.toString(),
      profit: lineProfit.toString(),
    });
  });

  // Populated inside the transaction below, published after it commits --
  // declared out here (not inside the $transaction callback) so it's still
  // reachable once the transaction has resolved.
  const stockAlertEvents: PendingStockAlertEvent[] = [];

  const result = await prisma.$transaction(async (tx) => {
    // Claim first: the unique constraint on (business_id, key, endpoint) is the
    // real guard against a concurrent duplicate submission -- a collision here
    // rolls this whole transaction back, leaving the key free for a legitimate
    // retry if the earlier attempt genuinely failed.
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_SALE_ENDPOINT);

    // Module 05: real customer link, shared with Debts -- an archived
    // customer holding this phone is never reused/reactivated (active-only
    // lookup). Absent customerPhone, customerId stays null -- byte-identical
    // to this sale's behavior before Module 05 existed.
    let customerId: string | null = null;
    if (input.customerPhone) {
      const customer = await findOrCreateCustomer(tx, {
        businessId: actor.businessId,
        phoneRaw: input.customerPhone,
        name: input.customerName,
        defaultCountry: business.country,
      });
      customerId = customer.id;
    }

    // Atomic conditional decrement per line -- see plan decision #5. findFirst
    // only picks *which* row to target (unavoidable given the documented
    // NULL-size dedup gap on branch_inventory); the accept/reject decision is
    // made by the DB, atomically, in the updateMany's own WHERE clause, not
    // from this read.
    const decrements: { productId: string; size: string | null; quantityBefore: Prisma.Decimal; quantityAfter: Prisma.Decimal }[] =
      [];
    for (const line of input.items) {
      const product = productMap.get(line.productId)!;
      const row = await tx.branch_inventory.findFirst({
        where: { business_id: actor.businessId, branch_id: input.branchId, product_id: product.id, size: normalizeSize(line.size) },
        orderBy: { id: "asc" },
      });
      if (!row) {
        throw conflict(`Insufficient stock for product "${product.name}"`);
      }
      const result = await tx.branch_inventory.updateMany({
        where: { id: row.id, quantity: { gte: line.quantity } },
        data: { quantity: { decrement: line.quantity }, version: { increment: 1 }, last_updated: new Date() },
      });
      if (result.count === 0) {
        throw conflict(`Insufficient stock for product "${product.name}"`);
      }

      // Re-read the row's TRUE post-write state within this same transaction
      // rather than computing quantityAfter/wasActive from the pre-write
      // `row` snapshot above. Postgres always serializes the actual UPDATE
      // via row locking, so the DB-side quantity itself is correct even
      // under concurrency -- but `row` (read before this line's own write)
      // goes stale the instant another concurrent sale's decrement commits
      // in between. QA reproduced this live under real concurrent sales: the
      // stale snapshot fed a wrong quantity_before/quantity_after pair into
      // inventory_adjustments AND a stale wasActive into
      // applyStockAlertTransition, double-firing StockLow for one episode.
      const committedRow = await tx.branch_inventory.findUniqueOrThrow({ where: { id: row.id } });
      const quantityAfter = committedRow.quantity;
      decrements.push({
        productId: product.id,
        size: normalizeSize(line.size),
        quantityBefore: quantityAfter.plus(line.quantity),
        quantityAfter,
      });
      const stockEvent = await applyStockAlertTransition(tx, {
        businessId: actor.businessId,
        branchId: input.branchId,
        productId: product.id,
        branchInventoryId: row.id,
        wasActive: committedRow.low_stock_alert_active,
        minStockLevel: product.min_stock_level,
        quantityAfter,
        direction: "decrease",
      });
      if (stockEvent) stockAlertEvents.push(stockEvent);
    }

    const receiptNumber = await getNextReceiptNumber(tx, actor.businessId, business.timezone);

    const createdSale = await tx.sales.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        branch_id: input.branchId,
        cashier_id: actor.userId,
        customer_phone: input.customerPhone,
        customer_id: customerId,
        items: items as unknown as Prisma.InputJsonValue,
        subtotal: subtotal.toDecimalPlaces(2),
        discount: discountAmount,
        discount_type: input.discount?.type,
        tax_amount: taxAmount,
        total: total.toDecimalPlaces(2),
        payment_method_id: input.paymentMethodId,
        payment_reference: input.paymentReference,
        profit: totalProfit.toDecimalPlaces(2),
        receipt_id: receiptNumber,
        status: "completed",
        salesperson_employee_id: input.salespersonEmployeeId,
      },
    });

    // Module 12 Session C -- history is complete from event #1: even the
    // very first assignment at creation gets its own sale_attribution_events
    // row (source: "creation"), not just later corrections.
    if (input.salespersonEmployeeId) {
      await tx.sale_attribution_events.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          sale_id: createdSale.id,
          previous_employee_id: null,
          new_employee_id: input.salespersonEmployeeId,
          changed_by: actor.userId,
          reason: "Original attribution at sale creation",
          source: "creation",
        },
      });
    }

    // Module 06 (Receipt System) -- generated inside THIS transaction, same
    // one as the Sale itself, so a later rollback (for any reason) rolls
    // the receipt back too (No Orphan Receipts). Published post-commit
    // below, never from in here.
    const saleReceipt = await generateReceiptInTransaction(tx, {
      businessId: actor.businessId,
      timezone: business.timezone,
      settings: business.settings,
      currencyCode: business.currency,
      receiptType: "sale",
      source: { saleId: createdSale.id },
      subtotal: createdSale.subtotal,
      discount: createdSale.discount,
      taxAmount: createdSale.tax_amount,
      feeAmount: createdSale.fee_amount,
      total: createdSale.total,
      snapshot: buildSaleReceiptSnapshot(business, items, paymentMethodName),
      createdBy: actor.userId,
    });

    if (customerId) {
      await tx.customers.updateMany({
        where: { id: customerId },
        data: {
          total_spent: { increment: createdSale.total },
          purchase_count: { increment: 1 },
          last_purchase_at: createdSale.timestamp,
          last_activity_at: createdSale.timestamp,
        },
      });
    }

    // One unified ledger row per line -- extends inventory_adjustments (see
    // Session 3A plan's #11 decision) rather than a parallel movements table.
    for (const decrement of decrements) {
      await tx.inventory_adjustments.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          product_id: decrement.productId,
          branch_id: input.branchId,
          quantity_before: decrement.quantityBefore,
          quantity_after: decrement.quantityAfter,
          adjustment_amount: decrement.quantityBefore.minus(decrement.quantityAfter),
          adjustment_type: "sale",
          packaging_level: "each",
          sale_id: createdSale.id,
          reason: `Sale ${createdSale.id}`,
          adjusted_by: actor.userId,
        },
      });
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "sale.created",
      entityType: "sale",
      entityId: createdSale.id,
      reason: `Sale ${receiptNumber} created for ${total.toDecimalPlaces(2).toString()} ${business.currency}`,
    });

    if (discountAmount.greaterThan(0)) {
      await writeAuditLog(tx, {
        businessId: actor.businessId,
        userId: actor.userId,
        userName: actor.userName,
        userRole: actor.userRole,
        action: "sale.discount_applied",
        entityType: "sale",
        entityId: createdSale.id,
        reason: `Discount of ${discountAmount.toString()} (${input.discount?.type}) applied to sale ${receiptNumber}`,
      });
    }

    // Response body normalized through JSON round-trip (Decimal/Date -> string via
    // their own toJSON) so a replayed response is byte-identical to the original.
    const responseBody = JSON.parse(JSON.stringify({ data: createdSale })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_SALE_ENDPOINT, 201, responseBody);

    return { sale: createdSale, receipt: saleReceipt };
  }, SALE_TRANSACTION_OPTIONS);
  const { sale, receipt: saleReceipt } = result;

  // Published after commit, never from inside the transaction -- a listener
  // should never react to data that might still roll back. SaleCreated still
  // has no subscriber (Notification/Analytics/CRM/Accounting are all
  // unbuilt); StockLow/StockRecovered below do -- src/lib/stockAlertSubscriber.ts,
  // the first real production subscriber in this repo.
  domainEvents.publish("SaleCreated", {
    saleId: sale.id,
    businessId: actor.businessId,
    branchId: sale.branch_id,
    receiptId: sale.receipt_id,
    total: sale.total.toString(),
  });
  if (sale.salesperson_employee_id) {
    domainEvents.publish("SaleAttributionSet", {
      businessId: actor.businessId,
      saleId: sale.id,
      employeeId: sale.salesperson_employee_id,
      occurredAt: sale.timestamp.toISOString(),
    });
  }
  domainEvents.publish("ReceiptGenerated", {
    businessId: actor.businessId,
    receiptId: saleReceipt.id,
    receiptNumber: saleReceipt.receipt_number,
    receiptType: saleReceipt.receipt_type,
  });
  for (const event of stockAlertEvents) {
    domainEvents.publish(event.name, event.payload);
  }

  return sale;
}

export async function voidSale(saleId: string, input: VoidSaleInput, actor: Actor, idempotencyKey: string) {
  const sale = await getOwned(prisma.sales.findUnique({ where: { id: saleId } }), actor.businessId, "Sale");

  // Route-level requireRole("owner", "cashier") (super_admin bypasses there
  // too) can't express "only THIS cashier's own sale" -- that ownership check
  // only makes sense for the cashier role; owner/super_admin skip it entirely.
  if (actor.userRole === "cashier" && sale.cashier_id !== actor.userId) {
    throw forbidden("Only the cashier who created this sale can void it");
  }

  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  if (!isSameBusinessDay(business.timezone, business.business_day_start_time, sale.timestamp, new Date())) {
    throw badRequest("Sale can only be voided on the same business day it was created; use Refund after day-close");
  }

  const items = sale.items as unknown as SaleLineSnapshot[];
  // Batch-fetched upfront, same reasoning as createSale's own productMap --
  // min_stock_level is needed per line to check for a stock recovery, and
  // the sale's own item snapshot doesn't carry it.
  const voidProducts = await prisma.products.findMany({ where: { id: { in: items.map((item) => item.productId) } } });
  const voidProductMap = new Map(voidProducts.map((p) => [p.id, p]));
  const stockAlertEvents: PendingStockAlertEvent[] = [];

  const voided = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, voidSaleEndpoint(saleId));

    // Single atomic guarded transition enforces Final State Protection: a
    // sale already voided, already refunded, or modified concurrently by
    // another request all fail this same WHERE clause identically.
    const result = await tx.sales.updateMany({
      where: { id: saleId, business_id: actor.businessId, version: input.version, status: "completed" },
      data: { status: "void", void_reason: input.reason, version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw conflict("Sale is not in a voidable state (already voided/refunded, or was modified concurrently)");
    }

    // Module 06 (Receipt System) -- Void creates no new financial row, so no
    // new receipt either (confirmed Phase 0). Only the EXISTING Sale
    // Receipt's own status moves, ISSUED -> VOIDED, inside this same
    // transaction. Never mutates the receipt's financial snapshot.
    await markSaleReceiptVoided(tx, actor.businessId, saleId);

    // A void means the money wasn't really spent -- total_spent is corrected
    // back out. purchase_count/last_purchase_at deliberately do NOT move: the
    // purchase still happened as an event, it's only the balance that's wrong
    // now (same distinction debt_balance's write-off correction already
    // draws against total_debts staying untouched).
    if (sale.customer_id) {
      await tx.customers.updateMany({
        where: { id: sale.customer_id },
        data: { total_spent: { decrement: sale.total }, last_activity_at: new Date() },
      });
    }

    // Restore inventory using the sale's own immutable item snapshot -- never
    // estimated, never recomputed from current stock (Rule #2).
    for (const item of items) {
      const quantity = new Prisma.Decimal(item.quantity);
      const row = await tx.branch_inventory.findFirst({
        where: { business_id: actor.businessId, branch_id: sale.branch_id, product_id: item.productId, size: normalizeSize(item.size) },
        orderBy: { id: "asc" },
      });
      if (!row) {
        throw conflict(`No stock record found to restore for product "${item.productName}"`);
      }
      const restoreResult = await tx.branch_inventory.updateMany({
        where: { id: row.id },
        data: { quantity: { increment: quantity }, version: { increment: 1 }, last_updated: new Date() },
      });
      if (restoreResult.count === 0) {
        throw conflict(`Failed to restore stock for product "${item.productName}"`);
      }

      // Re-read the TRUE post-write state within this same transaction --
      // same fix, same reasoning as createSale's decrement loop (see comment
      // there): `row` was read before this write and goes stale under real
      // concurrency, corrupting both the ledger and the debounce decision.
      const committedRow = await tx.branch_inventory.findUniqueOrThrow({ where: { id: row.id } });
      const restoredQuantity = committedRow.quantity;
      const quantityBefore = restoredQuantity.minus(quantity);
      const voidProduct = voidProductMap.get(item.productId);
      const stockEvent = await applyStockAlertTransition(tx, {
        businessId: actor.businessId,
        branchId: sale.branch_id,
        productId: item.productId,
        branchInventoryId: row.id,
        wasActive: committedRow.low_stock_alert_active,
        minStockLevel: voidProduct?.min_stock_level ?? null,
        quantityAfter: restoredQuantity,
        direction: "increase",
      });
      if (stockEvent) stockAlertEvents.push(stockEvent);

      // adjustment_amount must stay positive (CHECK chk_inventory_adj_amount_positive)
      // -- quantity_after > quantity_before here, the mirror of the sale's own
      // decrement where quantity_before > quantity_after.
      await tx.inventory_adjustments.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          product_id: item.productId,
          branch_id: sale.branch_id,
          quantity_before: quantityBefore,
          quantity_after: restoredQuantity,
          adjustment_amount: quantity,
          adjustment_type: "void",
          packaging_level: "each",
          sale_id: sale.id,
          reason: `Void of sale ${sale.id}`,
          adjusted_by: actor.userId,
        },
      });
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "sale.voided",
      entityType: "sale",
      entityId: sale.id,
      reason: input.reason,
    });

    const updated = await tx.sales.findUniqueOrThrow({ where: { id: saleId } });

    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, voidSaleEndpoint(saleId), 200, responseBody);

    return updated;
  }, SALE_TRANSACTION_OPTIONS);

  domainEvents.publish("SaleVoided", { saleId: voided.id, businessId: actor.businessId, reason: input.reason });
  for (const event of stockAlertEvents) {
    domainEvents.publish(event.name, event.payload);
  }

  return voided;
}

// Sale Refund, Partial Refund & Inventory Restoration -- one 0-based
// lineIndex into the ORIGINAL sale's own immutable `items` array,
// normalized to a canonical {returnedQuantity, restockableQuantity,
// writeOffQuantity} shape regardless of which of the two input shapes
// (simple boolean vs. explicit mixed quantity) the client sent. Pure,
// no DB access -- runs before the transaction.
interface NormalizedRefundLine {
  lineIndex: number;
  returnedQuantity: Prisma.Decimal;
  restockableQuantity: Prisma.Decimal;
  writeOffQuantity: Prisma.Decimal;
}

function normalizeRefundLines(inputLines: RefundSaleLineInput[], items: SaleLineSnapshot[]): NormalizedRefundLine[] {
  const seen = new Set<number>();
  return inputLines.map((line) => {
    if (line.lineIndex < 0 || line.lineIndex >= items.length) {
      throw badRequest(`lineIndex ${line.lineIndex} is out of range for this sale's ${items.length} line item(s)`);
    }
    if (seen.has(line.lineIndex)) {
      throw badRequest(`Duplicate lineIndex ${line.lineIndex} in refund request`);
    }
    seen.add(line.lineIndex);

    const returnedQuantity = new Prisma.Decimal(line.returnedQuantity);
    const restockableQuantity = "restockable" in line ? (line.restockable ? returnedQuantity : new Prisma.Decimal(0)) : new Prisma.Decimal(line.restockableQuantity);
    if (restockableQuantity.greaterThan(returnedQuantity)) {
      throw badRequest(`restockableQuantity cannot exceed returnedQuantity for lineIndex ${line.lineIndex}`);
    }
    const writeOffQuantity = returnedQuantity.minus(restockableQuantity);

    return { lineIndex: line.lineIndex, returnedQuantity, restockableQuantity, writeOffQuantity };
  });
}

export async function refundSale(saleId: string, input: RefundSaleInput, actor: Actor, idempotencyKey: string) {
  const sale = await getOwned(prisma.sales.findUnique({ where: { id: saleId } }), actor.businessId, "Sale");

  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  if (isSameBusinessDay(business.timezone, business.business_day_start_time, sale.timestamp, new Date())) {
    throw badRequest("Sale cannot be refunded on the same business day it was created; use Void instead");
  }

  const items = sale.items as unknown as SaleLineSnapshot[];
  const normalizedLines = normalizeRefundLines(input.items, items);

  // Batch-fetched upfront, same reasoning as Void's own voidProductMap --
  // min_stock_level is needed per restocked line to check for a stock
  // recovery, and the sale's own item snapshot doesn't carry it.
  const touchedProductIds = normalizedLines.map((l) => items[l.lineIndex].productId);
  const refundProducts = await prisma.products.findMany({ where: { id: { in: touchedProductIds } } });
  const refundProductMap = new Map(refundProducts.map((p) => [p.id, p]));
  const stockAlertEvents: PendingStockAlertEvent[] = [];

  const refundResult = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, refundSaleEndpoint(saleId));

    // Row-level lock on the original sale -- serializes any two concurrent
    // refund attempts against the SAME sale so the remaining-refundable-
    // quantity check below can never race (two simultaneous partial
    // refunds each reading "enough remains" and together over-refunding).
    // A standard Postgres transactional row lock, not the advisory-lock
    // approach already tried and abandoned elsewhere in this repo (Module
    // 11 Session B) for an unrelated table.
    await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId} FOR UPDATE`;

    // Re-fetch INSIDE the lock -- must see truly committed state, never the
    // pre-transaction read above, which could already be stale.
    const lockedSale = await tx.sales.findUniqueOrThrow({ where: { id: saleId } });
    if (lockedSale.version !== input.version) {
      throw conflict("Sale was modified concurrently, please retry with the latest version");
    }
    if (lockedSale.status !== "completed" && lockedSale.status !== "partially_refunded") {
      throw conflict("Sale is not in a refundable state (already fully refunded/voided, or was modified concurrently)");
    }

    // Remaining-refundable-quantity, computed from sale_refund_items'
    // own persisted history -- never from a cached/denormalized value that
    // could drift. business_id repeated here as a defense-in-depth scope
    // even though sale_id is already confirmed owned above (matches this
    // repo's own receipt_delivery_attempts precedent for the same reasoning).
    const existingRefundItems = await tx.sale_refund_items.findMany({
      where: { business_id: actor.businessId, sale_refunds: { sale_id: saleId } },
    });
    const alreadyRefunded = new Map<number, Prisma.Decimal>();
    for (const r of existingRefundItems) {
      alreadyRefunded.set(r.line_index, (alreadyRefunded.get(r.line_index) ?? new Prisma.Decimal(0)).plus(r.returned_quantity));
    }

    for (const line of normalizedLines) {
      const original = items[line.lineIndex];
      const originalQty = new Prisma.Decimal(original.quantity);
      const already = alreadyRefunded.get(line.lineIndex) ?? new Prisma.Decimal(0);
      const remaining = originalQty.minus(already);
      if (line.returnedQuantity.greaterThan(remaining)) {
        throw badRequest(`Cannot refund ${line.returnedQuantity.toString()} of "${original.productName}" (lineIndex ${line.lineIndex}) -- only ${remaining.toString()} remains refundable`);
      }
    }

    // Whole-sale exhaustion, across EVERY line of the original sale (not
    // just the lines touched by this event) -- partially_refunded is a
    // derived business/UI state, computed here from the same
    // sale_refund_items history that is the real source of truth.
    const projectedRefunded = new Map(alreadyRefunded);
    for (const line of normalizedLines) {
      projectedRefunded.set(line.lineIndex, (projectedRefunded.get(line.lineIndex) ?? new Prisma.Decimal(0)).plus(line.returnedQuantity));
    }
    const fullyRefunded = items.every((item, idx) => (projectedRefunded.get(idx) ?? new Prisma.Decimal(0)).greaterThanOrEqualTo(new Prisma.Decimal(item.quantity)));
    const newStatus: "refunded" | "partially_refunded" = fullyRefunded ? "refunded" : "partially_refunded";

    // Same atomic guard shape as Void -- covers already-voided, already-
    // fully-refunded, and concurrent-modification in one statement. Belt-
    // and-suspenders alongside the early lockedSale check above (matching
    // Purchase Orders' own established "JS pre-check in addition to the
    // atomic guard" pattern). The original row's financial fields
    // (subtotal/discount/tax_amount/total/profit/items) are never written
    // here; only status + version change (Rule #3's "never modify the
    // original Sale" is about the financial record, not lifecycle metadata).
    const guardResult = await tx.sales.updateMany({
      where: { id: saleId, business_id: actor.businessId, version: input.version, status: { in: ["completed", "partially_refunded"] } },
      data: { status: newStatus, version: { increment: 1 } },
    });
    if (guardResult.count === 0) {
      throw conflict("Sale is not in a refundable state (already fully refunded/voided, or was modified concurrently)");
    }

    // Per-line proration of this event's own refunded portion, using the
    // SAME "round once at the point first computed, sum the rounded
    // values" discipline Sale Creation's own line-item-subtotal fix
    // established -- each original line already carries its own immutable
    // snapshot for its FULL original quantity, prorated down by
    // returnedQuantity/originalQuantity for a partial-quantity return.
    const computedLines = normalizedLines.map((line) => {
      const original = items[line.lineIndex];
      const originalQty = new Prisma.Decimal(original.quantity);
      const fraction = line.returnedQuantity.dividedBy(originalQty);
      const refundLineSubtotal = new Prisma.Decimal(original.lineSubtotal).mul(fraction).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const refundLineDiscount = new Prisma.Decimal(original.discount).mul(fraction).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const refundLineTax = new Prisma.Decimal(original.tax).mul(fraction).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const refundLineProfit = new Prisma.Decimal(original.profit).mul(fraction).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      return { ...line, original, refundLineSubtotal, refundLineDiscount, refundLineTax, refundLineProfit };
    });

    const refundSubtotal = computedLines.reduce((sum, l) => sum.plus(l.refundLineSubtotal), new Prisma.Decimal(0));
    const refundDiscount = computedLines.reduce((sum, l) => sum.plus(l.refundLineDiscount), new Prisma.Decimal(0));
    const refundTax = computedLines.reduce((sum, l) => sum.plus(l.refundLineTax), new Prisma.Decimal(0));
    const refundProfit = computedLines.reduce((sum, l) => sum.plus(l.refundLineProfit), new Prisma.Decimal(0));
    const refundTotal = refundSubtotal.minus(refundDiscount).plus(refundTax);

    const reversalItems: SaleLineSnapshot[] = computedLines.map((l) => ({
      productId: l.original.productId,
      productName: l.original.productName,
      size: l.original.size,
      quantity: l.returnedQuantity.toString(),
      sellingPriceAtSale: l.original.sellingPriceAtSale,
      costPriceAtSale: l.original.costPriceAtSale,
      lineSubtotal: l.refundLineSubtotal.toString(),
      discount: l.refundLineDiscount.toString(),
      tax: l.refundLineTax.toString(),
      profit: l.refundLineProfit.toString(),
    }));

    const receiptNumber = await getNextReceiptNumber(tx, actor.businessId, business.timezone);

    // Financial reversal: a brand-new sales row, self-linked via the
    // already-existing refund_of_sale_id column, SCOPED to just this
    // event's own refunded lines/quantities (never the whole original
    // sale) -- every money figure negated 1:1 so `total = subtotal -
    // discount + tax` still holds for this row too. Each refund event gets
    // its OWN reversal row, which is what lets Receipts/Customer
    // total_spent/Commission's getEligibleSalesForPeriod keep working
    // completely unchanged. chk_sales_total_nonneg already permits total <
    // 0 specifically when refund_of_sale_id is set.
    const reversal = await tx.sales.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        branch_id: sale.branch_id,
        cashier_id: actor.userId,
        customer_phone: sale.customer_phone,
        customer_id: sale.customer_id,
        items: reversalItems as unknown as Prisma.InputJsonValue,
        subtotal: refundSubtotal.negated(),
        discount: refundDiscount.negated(),
        discount_type: sale.discount_type,
        tax_amount: refundTax.negated(),
        total: refundTotal.negated(),
        payment_method_id: sale.payment_method_id,
        payment_reference: sale.payment_reference,
        profit: refundProfit.negated(),
        receipt_id: receiptNumber,
        status: "refunded",
        refund_of_sale_id: sale.id,
        // Module 12 Session C -- copied forward, same "never re-derive,
        // always carry the original's own value" pattern customer_id/items/
        // payment_method_id already use. This is what makes a refund
        // naturally net against the SAME employee's eligible sales -- no
        // separate netting logic needed, see getEligibleSalesForPeriod.
        // Deliberately NOT logged to sale_attribution_events -- this is an
        // automatic carry-forward of an already-decided fact, not a new
        // attribution decision.
        salesperson_employee_id: sale.salesperson_employee_id,
      },
    });

    const saleRefundId = generateId();
    await tx.sale_refunds.create({
      data: {
        id: saleRefundId,
        business_id: actor.businessId,
        sale_id: saleId,
        reversal_sale_id: reversal.id,
        reason: input.reason,
        created_by: actor.userId,
      },
    });
    for (const line of computedLines) {
      await tx.sale_refund_items.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          sale_refund_id: saleRefundId,
          line_index: line.lineIndex,
          product_id: line.original.productId,
          returned_quantity: line.returnedQuantity,
          restockable_quantity: line.restockableQuantity,
          write_off_quantity: line.writeOffQuantity,
          unit_cost_snapshot: new Prisma.Decimal(line.original.costPriceAtSale),
        },
      });
    }

    // Restore inventory ONLY for the restockable portion of each line,
    // using that line's own original cost snapshot (never a fresh product
    // lookup) and the ORIGINAL sale's own branch (never the actor's
    // current branch) -- reusing Void's exact per-line restoration pattern
    // (findFirst -> atomic guarded updateMany -> re-read committed state
    // -> stock-alert transition -> a positive inventory_adjustments row),
    // never a duplicated mechanism. The write-off portion touches no
    // inventory at all.
    for (const line of computedLines) {
      if (line.restockableQuantity.lessThanOrEqualTo(0)) continue;

      const row = await tx.branch_inventory.findFirst({
        where: { business_id: actor.businessId, branch_id: sale.branch_id, product_id: line.original.productId, size: normalizeSize(line.original.size) },
        orderBy: { id: "asc" },
      });
      if (!row) {
        throw conflict(`No stock record found to restore for product "${line.original.productName}"`);
      }
      const restoreResult = await tx.branch_inventory.updateMany({
        where: { id: row.id },
        data: { quantity: { increment: line.restockableQuantity }, version: { increment: 1 }, last_updated: new Date() },
      });
      if (restoreResult.count === 0) {
        throw conflict(`Failed to restore stock for product "${line.original.productName}"`);
      }

      const committedRow = await tx.branch_inventory.findUniqueOrThrow({ where: { id: row.id } });
      const restoredQuantity = committedRow.quantity;
      const quantityBefore = restoredQuantity.minus(line.restockableQuantity);
      const product = refundProductMap.get(line.original.productId);
      const stockEvent = await applyStockAlertTransition(tx, {
        businessId: actor.businessId,
        branchId: sale.branch_id,
        productId: line.original.productId,
        branchInventoryId: row.id,
        wasActive: committedRow.low_stock_alert_active,
        minStockLevel: product?.min_stock_level ?? null,
        quantityAfter: restoredQuantity,
        direction: "increase",
      });
      if (stockEvent) stockAlertEvents.push(stockEvent);

      // adjustment_amount must stay positive (CHECK chk_inventory_adj_amount_positive)
      // -- mirrors Void's own restoration ledger row shape exactly.
      await tx.inventory_adjustments.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          product_id: line.original.productId,
          branch_id: sale.branch_id,
          quantity_before: quantityBefore,
          quantity_after: restoredQuantity,
          adjustment_amount: line.restockableQuantity,
          adjustment_type: "refund_restock",
          packaging_level: "each",
          sale_id: sale.id,
          reason: `Refund restock of sale ${sale.id}: ${line.restockableQuantity.toString()} of "${line.original.productName}"`,
          adjusted_by: actor.userId,
        },
      });
    }

    // Module 06 (Receipt System) -- the original's own Sale Receipt moves to
    // `partially_refunded` or the terminal `refunded` (never mutated
    // financially), and a brand-new Refund Receipt is generated for THIS
    // event's own scoped reversal, linked back via refund_of_receipt_id.
    // All inside this same transaction.
    await markSaleReceiptRefunded(tx, actor.businessId, sale.id, fullyRefunded);
    const originalReceipt = await tx.receipts.findFirst({
      where: { business_id: actor.businessId, sale_id: sale.id, receipt_type: "sale" },
    });
    let refundPaymentMethodName: string | null = null;
    if (sale.payment_method_id) {
      const pm = await tx.payment_methods.findUnique({ where: { id: sale.payment_method_id } });
      refundPaymentMethodName = pm?.name ?? null;
    }
    const refundReceipt = await generateReceiptInTransaction(tx, {
      businessId: actor.businessId,
      timezone: business.timezone,
      settings: business.settings,
      currencyCode: business.currency,
      receiptType: "refund",
      source: { saleId: reversal.id },
      subtotal: reversal.subtotal,
      discount: reversal.discount,
      taxAmount: reversal.tax_amount,
      feeAmount: reversal.fee_amount,
      total: reversal.total,
      snapshot: buildRefundReceiptSnapshot(business, reversalItems, refundPaymentMethodName, originalReceipt?.receipt_number ?? sale.receipt_id ?? sale.id),
      createdBy: actor.userId,
      refundOfReceiptId: originalReceipt?.id,
    });

    // reversal.total is already negated -- incrementing by it naturally nets
    // total_spent back down by THIS event's own refunded amount. No fresh
    // customer lookup here: customer_id is copied straight from the
    // original sale above, never re-derived from customer_phone.
    if (reversal.customer_id) {
      await tx.customers.updateMany({
        where: { id: reversal.customer_id },
        data: { total_spent: { increment: reversal.total }, last_activity_at: new Date() },
      });
    }

    // No refund_reason column exists (unlike Void's void_reason) -- the
    // AuditLog's own required `reason` is this repo's canonical "why" record,
    // so that's where it lives (see Session 3B plan decision #4).
    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "sale.refunded",
      entityType: "sale",
      entityId: sale.id,
      reason: `${input.reason} (refund receipt ${receiptNumber}, ${reversal.total.toString()} ${business.currency}, ${fullyRefunded ? "fully refunded" : "partially refunded"})`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: reversal })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, refundSaleEndpoint(saleId), 201, responseBody);

    return { reversal, refundReceipt };
  }, SALE_TRANSACTION_OPTIONS);
  const { reversal: refund, refundReceipt } = refundResult;

  domainEvents.publish("RefundCreated", {
    saleId: sale.id,
    refundSaleId: refund.id,
    businessId: actor.businessId,
    total: refund.total.toString(),
    reason: input.reason,
  });
  domainEvents.publish("ReceiptGenerated", {
    businessId: actor.businessId,
    receiptId: refundReceipt.id,
    receiptNumber: refundReceipt.receipt_number,
    receiptType: refundReceipt.receipt_type,
  });
  for (const event of stockAlertEvents) {
    domainEvents.publish(event.name, event.payload);
  }

  return refund;
}

// Module 12 Session C -- the ONLY way to correct attribution after
// creation, never a re-POST of the sale. Owner/Manager only (confirmed --
// no per-resource cashier exception the way Void has one; a correction is
// a financial-integrity action, not a physical-possession one). Version-
// guarded (reusing sales' own existing version column, the same field
// Void/Refund already optimistic-lock against) + Idempotency-Key. Writes
// exactly one sale_attribution_events row per call, regardless of whether
// this is the sale's first-ever assignment (created with none) or a real
// change of an existing one -- both are "correction" source from this
// endpoint's own point of view; only sale creation itself ever writes
// source: "creation".
// Module 12 Session D, Locked Decision #4 + its addendum guardrail --
// Automatic Commission Reallocation. Bounded, pending-only rule: if the
// affected sale's own payroll period has a payroll_records row for BOTH
// the original and newly-attributed employee, and BOTH are still
// "pending" AND both commission-driven models (PERCENTAGE/
// FIXED_PLUS_PERCENTAGE), a single value X -- the sale's own commission
// contribution, computed ONCE from the ORIGINAL record's own already-
// STORED calculation_breakdown.commissionRate (never re-derived, never a
// new payroll-generation mechanism) -- is moved as a signed pair of
// commission_adjustments rows (-X from the original, +X to the new
// employee), inside this SAME transaction. Any other case (a record
// missing, either side PAID, either side not commission-driven, or no
// prior/new attribution at all) is reported back via `reallocation` but
// never silently guessed, never partially applied, and never creates a
// missing payroll_records row.
const COMMISSION_DRIVEN_MODELS = ["PERCENTAGE", "FIXED_PLUS_PERCENTAGE"] as const;

interface ReallocationResult {
  status: "not_applicable" | "success" | "skipped_missing_records" | "skipped_paid" | "skipped_non_commission_model";
  amount?: string;
}

export async function setSaleAttribution(saleId: string, input: SetSaleAttributionInput, actor: Actor, idempotencyKey: string) {
  const sale = await getOwned(prisma.sales.findUnique({ where: { id: saleId } }), actor.businessId, "Sale");

  if (input.employeeId) {
    await getOwned(prisma.employees.findUnique({ where: { id: input.employeeId } }), actor.businessId, "Employee");
  }

  const endpoint = setSaleAttributionEndpoint(saleId);
  const previousEmployeeId = sale.salesperson_employee_id;

  // Batch 3 remediation (finding #5) -- previously mirrored
  // getEligibleSalesForPeriod's own (buggy) UTC-month bucketing on purpose,
  // to stay consistent with "which period does this sale count toward for
  // commission eligibility." Now that getEligibleSalesForPeriod itself is
  // fixed to use the business's real local calendar month
  // (getBusinessMonthBounds, commission.service.ts), this must be fixed the
  // same way to keep matching it -- using getBusinessLocalYear/
  // getBusinessLocalMonth (the existing instant -> local-period direction,
  // not getBusinessMonthBounds, which is the opposite direction:
  // period -> instant range).
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId }, select: { timezone: true } });
  const periodYear = getBusinessLocalYear(business.timezone, sale.timestamp);
  const periodMonth = getBusinessLocalMonth(business.timezone, sale.timestamp);

  const { updated, reallocation } = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, endpoint);

    const updateResult = await tx.sales.updateMany({
      where: { id: saleId, business_id: actor.businessId, version: input.version },
      data: { salesperson_employee_id: input.employeeId, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Sale was modified concurrently, please retry with the latest version");
    }

    await tx.sale_attribution_events.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        sale_id: saleId,
        previous_employee_id: previousEmployeeId,
        new_employee_id: input.employeeId,
        changed_by: actor.userId,
        reason: input.reason,
        source: "correction",
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "sale.attribution_changed",
      entityType: "sale",
      entityId: saleId,
      reason: input.reason,
    });

    let reallocationResult: ReallocationResult = { status: "not_applicable" };

    // Only a genuine employee-to-employee reattribution is a reallocation
    // candidate -- a set-from-null or clear-to-null has no "other side."
    if (previousEmployeeId && input.employeeId) {
      const [originalRecord, newRecord] = await Promise.all([
        tx.payroll_records.findFirst({ where: { business_id: actor.businessId, employee_id: previousEmployeeId, period_year: periodYear, period_month: periodMonth } }),
        tx.payroll_records.findFirst({ where: { business_id: actor.businessId, employee_id: input.employeeId, period_year: periodYear, period_month: periodMonth } }),
      ]);

      if (!originalRecord || !newRecord) {
        // Never silently create a missing payroll_records row, never
        // partially reallocate -- consumes only what payroll generation
        // already produced.
        reallocationResult = { status: "skipped_missing_records" };
      } else if (originalRecord.status === "paid" || newRecord.status === "paid") {
        // Preserve PAID immutability -- the attribution correction above
        // is still fully recorded via sale_attribution_events; any
        // financial consequence must go through commission_adjustments
        // (still-pending side) or payroll_reversals (paid side) manually.
        reallocationResult = { status: "skipped_paid" };
      } else if (
        !COMMISSION_DRIVEN_MODELS.includes(originalRecord.compensation_model as (typeof COMMISSION_DRIVEN_MODELS)[number]) ||
        !COMMISSION_DRIVEN_MODELS.includes(newRecord.compensation_model as (typeof COMMISSION_DRIVEN_MODELS)[number])
      ) {
        reallocationResult = { status: "skipped_non_commission_model" };
      } else {
        // The single value-preserving amount X: the sale's own commission
        // contribution, computed ONCE from the ORIGINAL record's own
        // already-stored rate -- never re-derived from current
        // employee_compensation (which could have changed since
        // generation), never a fresh eligible-sales recalculation (that
        // would be a new payroll-generation mechanism, explicitly
        // forbidden). The exact same amount moves on both sides, so total
        // commission across both records is unchanged by construction.
        const breakdown = originalRecord.calculation_breakdown as unknown as { commissionRate: string } | null;
        const rate = new Prisma.Decimal(breakdown?.commissionRate ?? "0");
        const contribution = sale.total.mul(rate).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

        if (contribution.greaterThan(0)) {
          await tx.commission_adjustments.create({
            data: {
              id: generateId(),
              business_id: actor.businessId,
              employee_id: previousEmployeeId,
              payroll_record_id: originalRecord.id,
              sale_id: saleId,
              delta_amount: contribution.negated(),
              reason: `Automatic reallocation: sale ${saleId} reattributed away from this employee`,
              created_by: actor.userId,
            },
          });
          await tx.commission_adjustments.create({
            data: {
              id: generateId(),
              business_id: actor.businessId,
              employee_id: input.employeeId,
              payroll_record_id: newRecord.id,
              sale_id: saleId,
              delta_amount: contribution,
              reason: `Automatic reallocation: sale ${saleId} reattributed to this employee`,
              created_by: actor.userId,
            },
          });
          reallocationResult = { status: "success", amount: contribution.toString() };
        } else {
          // Nothing to move (e.g. the original record's own breakdown had
          // no positive rate) -- not an error, just nothing to reallocate.
          reallocationResult = { status: "not_applicable" };
        }
      }
    }

    const result = await tx.sales.findUniqueOrThrow({ where: { id: saleId } });
    // Nest reallocation INSIDE data, matching the exact shape the
    // controller's own non-replayed response produces (`{ ...updated,
    // reallocation }`) -- a replayed response must be byte-identical to a
    // fresh one, same rule every other idempotent endpoint in this repo
    // already follows.
    const responseBody = JSON.parse(JSON.stringify({ data: { ...result, reallocation: reallocationResult } })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, endpoint, 200, responseBody);
    return { updated: result, reallocation: reallocationResult };
  });

  domainEvents.publish("SaleAttributionChanged", {
    businessId: actor.businessId,
    saleId,
    previousEmployeeId,
    newEmployeeId: input.employeeId,
    occurredAt: new Date().toISOString(),
  });
  if (reallocation.status === "success" && previousEmployeeId && input.employeeId) {
    domainEvents.publish("CommissionAdjustmentCreated", {
      businessId: actor.businessId,
      commissionAdjustmentId: "", // two rows were created; see audit log / sale_attribution_events for the pair
      employeeId: previousEmployeeId,
      payrollRecordId: "",
      deltaAmount: `-${reallocation.amount}`,
      occurredAt: new Date().toISOString(),
    });
    domainEvents.publish("CommissionAdjustmentCreated", {
      businessId: actor.businessId,
      commissionAdjustmentId: "",
      employeeId: input.employeeId,
      payrollRecordId: "",
      deltaAmount: reallocation.amount ?? "0",
      occurredAt: new Date().toISOString(),
    });
  }

  return { ...updated, reallocation };
}

export async function listSales(query: ListSalesQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["timestamp", "total", "subtotal"] as const,
    defaultSort: "timestamp",
    searchableFields: ["customer_phone", "receipt_id"],
  });

  const where = {
    business_id: businessId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.branchId ? { branch_id: query.branchId } : {}),
    ...(query.dateFrom || query.dateTo
      ? { timestamp: { ...(query.dateFrom ? { gte: query.dateFrom } : {}), ...(query.dateTo ? { lte: query.dateTo } : {}) } }
      : {}),
    ...resolved.searchWhere,
  };

  const [rows, total] = await Promise.all([
    prisma.sales.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.sales.count({ where }),
  ]);

  return paginate(rows, total, resolved.page, resolved.pageSize);
}

// Module 12 Session C -- bundles its own attribution history on the read,
// same "bundle related records on the parent's read endpoint" pattern as
// Expenses/PO GRN/Attendance's own adjustments.
export async function getSale(id: string, businessId: string) {
  const sale = await getOwned(
    prisma.sales.findUnique({ where: { id }, include: { sale_attribution_events: { orderBy: { changed_at: "asc" } } } }),
    businessId,
    "Sale"
  );

  // Batch 5 (HNT2-SALE-001), requirement #5 -- the sale's effective (net-of-
  // refunds) total, additive-only per the confirmed Decision 1 (the refund
  // HISTORY itself lives solely at GET /sales/:id/refunds, never embedded
  // here). Reuses exactly the definition the refund write path and
  // commission.service.ts's own getEligibleSalesForPeriod already rely on:
  // sale.total + Σ(every reversal sales row's own already-negated total) --
  // never a second, parallel calculation. Zero-refund-safe by construction
  // (sums to the original total when no reversal rows exist).
  const reversals = await prisma.sales.findMany({
    where: { business_id: businessId, refund_of_sale_id: id },
    select: { total: true },
  });
  const effectiveTotal = reversals.reduce((sum, r) => sum.plus(r.total), sale.total);

  return { ...sale, effectiveTotal: effectiveTotal.toString() };
}

// Batch 5 (HNT2-SALE-001) -- the dedicated, paginated refund-history
// subresource (Phase 0 Decision 1, confirmed: this is the SOLE read shape
// for refund history -- GET /sales/:id never embeds it). Header
// (sale_refunds) + child (sale_refund_items) shape, read back exactly as
// refundSale() wrote it. Line-level productName/size are sourced from the
// ORIGINAL sale's own immutable items[] snapshot at that lineIndex -- never
// a live product lookup -- the same point-in-time-accuracy principle
// costPriceAtSale already established (a later product rename must never
// retroactively change a historical refund line's own display name).
export async function listSaleRefunds(saleId: string, query: ListSaleRefundsQuery, businessId: string) {
  const sale = await getOwned(prisma.sales.findUnique({ where: { id: saleId } }), businessId, "Sale");
  const originalItems = sale.items as unknown as SaleLineSnapshot[];

  const resolved = resolveListQuery(query, {
    sortableFields: ["created_at"] as const,
    defaultSort: "created_at" as const,
  });

  // Batch 5 review round 2 -- resolveListQuery's own orderBy is single-key
  // only (created_at alone); under offset pagination, two refund events
  // sharing an identical created_at (a real possibility, not just a debt-
  // history-side concern) could otherwise return in a non-repeatable order
  // across pages, risking a duplicate or skipped event at the page
  // boundary. `id` (a generateId() value, globally unique) is a stable,
  // deterministic secondary key, applied in the SAME direction as the
  // primary sort so the overall order stays intuitive.
  const orderBy = [resolved.orderBy, { id: query.order }];

  const where = { business_id: businessId, sale_id: saleId };
  const [rows, total] = await Promise.all([
    prisma.sale_refunds.findMany({
      where,
      include: {
        sale_refund_items: { orderBy: { line_index: "asc" } },
        sales_reversal: true,
        users: true,
      },
      orderBy,
      skip: resolved.skip,
      take: resolved.take,
    }),
    prisma.sale_refunds.count({ where }),
  ]);

  // Refund-receipt reference, if one exists for each event's own reversal
  // sale -- batch-fetched in one query (N+1 avoidance), the same pattern
  // createSale's own product batch-fetch already established.
  const reversalSaleIds = rows.map((r) => r.reversal_sale_id);
  const refundReceipts = reversalSaleIds.length
    ? await prisma.receipts.findMany({
        where: { business_id: businessId, sale_id: { in: reversalSaleIds }, receipt_type: "refund" },
      })
    : [];
  const receiptByReversalSaleId = new Map(refundReceipts.map((r) => [r.sale_id as string, r]));

  const data = rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    // Reflects the CURRENT user record (name), never an immutable
    // historical snapshot at the time of the refund -- sale_refunds has no
    // name-snapshot column, flagged explicitly per Phase 0.
    actor: { userId: row.users.id, userName: row.users.name },
    timestamp: row.created_at,
    // Two explicit fields, per the confirmed API clarification: refundTotal
    // is a clear POSITIVE amount for API consumers; signedReversalTotal is
    // the raw, still-negated reversal-sale total every other reader of a
    // reversal row already relies on (e.g. commission.service.ts's own
    // netting via getEligibleSalesForPeriod). Internal math (getSale's own
    // effectiveTotal above) always sums the real signed value -- this pair
    // is a response-shape naming/clarity fix only, never a change to any
    // internal calculation.
    refundTotal: row.sales_reversal.total.negated().toString(),
    signedReversalTotal: row.sales_reversal.total.toString(),
    receiptReference: (() => {
      const receipt = receiptByReversalSaleId.get(row.reversal_sale_id);
      return receipt ? { id: receipt.id, receiptNumber: receipt.receipt_number } : null;
    })(),
    lines: row.sale_refund_items.map((item) => {
      const original = originalItems[item.line_index] as SaleLineSnapshot | undefined;
      return {
        lineIndex: item.line_index,
        productId: item.product_id,
        productName: original?.productName ?? null,
        size: original?.size ?? null,
        returnedQuantity: item.returned_quantity.toString(),
        restockableQuantity: item.restockable_quantity.toString(),
        writeOffQuantity: item.write_off_quantity.toString(),
        unitCostSnapshot: item.unit_cost_snapshot.toString(),
      };
    }),
  }));

  return paginate(data, total, resolved.page, resolved.pageSize);
}
