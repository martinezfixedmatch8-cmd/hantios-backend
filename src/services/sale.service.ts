import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest, conflict } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { getNextReceiptNumber } from "../lib/receiptNumber";
import type { CreateSaleInput, ListSalesQuery } from "../validation/sale.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Logical endpoint name for the idempotency_keys unique constraint -- stable
// even if the actual route path ever changes.
export const CREATE_SALE_ENDPOINT = "POST /sales";

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

  const sale = await prisma.$transaction(async (tx) => {
    // Claim first: the unique constraint on (business_id, key, endpoint) is the
    // real guard against a concurrent duplicate submission -- a collision here
    // rolls this whole transaction back, leaving the key free for a legitimate
    // retry if the earlier attempt genuinely failed.
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_SALE_ENDPOINT);

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
      decrements.push({
        productId: product.id,
        size: line.size ?? null,
        quantityBefore: row.quantity,
        quantityAfter: row.quantity.minus(line.quantity),
      });
    }

    const receiptNumber = await getNextReceiptNumber(tx, actor.businessId, business.timezone);

    const createdSale = await tx.sales.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        branch_id: input.branchId,
        cashier_id: actor.userId,
        customer_phone: input.customerPhone,
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
  });

  return sale;
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
