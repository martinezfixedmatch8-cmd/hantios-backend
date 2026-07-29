import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest, conflict, forbidden } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { getNextReceiptNumber } from "../lib/receiptNumber";
import { isSameBusinessDay } from "../lib/businessTime";
import { domainEvents } from "../lib/events";
import { applyStockAlertTransition } from "../lib/stockAlerts";
import type { PendingStockAlertEvent } from "../lib/stockAlerts";
import { findOrCreateCustomer } from "./customer.service";
import type { CreateSaleInput, ListSalesQuery, VoidSaleInput, RefundSaleInput } from "../validation/sale.schema";

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

  if (input.paymentMethodId) {
    const paymentMethod = await getOwned(
      prisma.payment_methods.findUnique({ where: { id: input.paymentMethodId } }),
      actor.businessId,
      "Payment method"
    );
    if (paymentMethod.status !== "active") {
      throw badRequest("Payment method is archived");
    }
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

  const sale = await prisma.$transaction(async (tx) => {
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
        where: { business_id: actor.businessId, branch_id: input.branchId, product_id: product.id, size: line.size ?? null },
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
        size: line.size ?? null,
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
      },
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

    return createdSale;
  }, SALE_TRANSACTION_OPTIONS);

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
        where: { business_id: actor.businessId, branch_id: sale.branch_id, product_id: item.productId, size: item.size },
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

export async function refundSale(saleId: string, input: RefundSaleInput, actor: Actor, idempotencyKey: string) {
  const sale = await getOwned(prisma.sales.findUnique({ where: { id: saleId } }), actor.businessId, "Sale");

  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  if (isSameBusinessDay(business.timezone, business.business_day_start_time, sale.timestamp, new Date())) {
    throw badRequest("Sale cannot be refunded on the same business day it was created; use Void instead");
  }

  const refund = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, refundSaleEndpoint(saleId));

    // Same atomic guard shape as Void -- covers already-voided, already-
    // refunded, and concurrent-modification in one statement. The original
    // row's financial fields (subtotal/discount/tax_amount/total/profit/items)
    // are never written here; only status + version change (Rule #3's
    // "never modify the original Sale" is about the financial record, not
    // lifecycle metadata -- see the Session 3B plan for the full reasoning).
    const result = await tx.sales.updateMany({
      where: { id: saleId, business_id: actor.businessId, version: input.version, status: "completed" },
      data: { status: "refunded", version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw conflict("Sale is not in a refundable state (already voided/refunded, or was modified concurrently)");
    }

    const receiptNumber = await getNextReceiptNumber(tx, actor.businessId, business.timezone);

    // Financial reversal: a brand-new sales row, self-linked via the
    // already-existing refund_of_sale_id column, every money figure negated
    // 1:1 so `total = subtotal - discount + tax` still holds for this row too.
    // chk_sales_total_nonneg already permits total < 0 specifically when
    // refund_of_sale_id is set -- confirmed by reading the live constraint
    // before this session, not assumed.
    const reversal = await tx.sales.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        branch_id: sale.branch_id,
        cashier_id: actor.userId,
        customer_phone: sale.customer_phone,
        customer_id: sale.customer_id,
        items: sale.items as unknown as Prisma.InputJsonValue,
        subtotal: sale.subtotal.negated(),
        discount: sale.discount.negated(),
        discount_type: sale.discount_type,
        tax_amount: sale.tax_amount.negated(),
        total: sale.total.negated(),
        payment_method_id: sale.payment_method_id,
        payment_reference: sale.payment_reference,
        profit: sale.profit.negated(),
        receipt_id: receiptNumber,
        status: "refunded",
        refund_of_sale_id: sale.id,
      },
    });

    // reversal.total is already negated -- incrementing by it naturally nets
    // total_spent back down by the refunded amount. No fresh customer lookup
    // here: customer_id is copied straight from the original sale above,
    // never re-derived from customer_phone.
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
      reason: `${input.reason} (refund receipt ${receiptNumber}, ${reversal.total.toString()} ${business.currency})`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: reversal })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, refundSaleEndpoint(saleId), 201, responseBody);

    return reversal;
  }, SALE_TRANSACTION_OPTIONS);

  domainEvents.publish("RefundCreated", {
    saleId: sale.id,
    refundSaleId: refund.id,
    businessId: actor.businessId,
    total: refund.total.toString(),
    reason: input.reason,
  });

  return refund;
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

export async function getSale(id: string, businessId: string) {
  return getOwned(prisma.sales.findUnique({ where: { id } }), businessId, "Sale");
}
