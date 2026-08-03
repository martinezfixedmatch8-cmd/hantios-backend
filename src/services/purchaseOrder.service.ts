import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { assertOwned, getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest, conflict } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { domainEvents } from "../lib/events";
import { getNextPurchaseOrderNumber } from "../lib/purchaseOrderNumber";
import { getCurrency } from "../lib/currencyReference";
import { expireSecureLinksForTerminalPo } from "./poSecureLink.service";
import type {
  CreatePurchaseOrderInput,
  UpdatePurchaseOrderInput,
  ListPurchaseOrdersQuery,
  SendPurchaseOrderInput,
  ConfirmPurchaseOrderInput,
  CancelPurchaseOrderInput,
} from "../validation/purchaseOrder.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_PO_ENDPOINT = "POST /purchase-orders";
export const sendPurchaseOrderEndpoint = (id: string): string => `POST /purchase-orders/${id}/send`;
export const confirmPurchaseOrderEndpoint = (id: string): string => `POST /purchase-orders/${id}/confirm`;
export const cancelPurchaseOrderEndpoint = (id: string): string => `POST /purchase-orders/${id}/cancel`;

// Same fix, same reasoning as every other transactional service in this
// repo (Sales/Debts/Products/Customers): Neon's serverless HTTP driver adds
// real per-query latency, and getNextPurchaseOrderNumber's atomic
// per-business counter row is a deliberate serialization point -- both
// `timeout` (time allowed once a transaction starts) and `maxWait` (time
// allowed to even begin one) need headroom under real concurrent load.
const PO_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

// Module 11 Session B -- GRN and PO Payment history are surfaced by bundling
// them onto the PO's own read endpoints (mirroring Expenses' EXPENSE_INCLUDE
// "bundle related records on the parent's read endpoint" pattern), not by
// adding new list endpoints -- this repo has no dedicated "list ledger
// history" endpoint anywhere (branch_inventory/inventory_adjustments have
// none either), deferred to the not-yet-built Reports Center.
const PO_ITEMS_INCLUDE = {
  purchase_order_items: true,
  goods_received_notes: { include: { goods_received_items: true } },
  purchase_order_payments: true,
} as const;

interface ResolvedLine {
  product_id: string;
  product_name_snapshot: string;
  sku_snapshot: string | null;
  quantity_ordered: Prisma.Decimal;
  unit_cost_snapshot: Prisma.Decimal;
  line_total: Prisma.Decimal;
}

// Shared by create and PATCH-while-DRAFT's item replacement. Validates every
// line's product belongs to the same business (via assertOwned, same
// same-404-either-way guarantee as the module's own supplier/branch checks
// -- kept consistent within Purchase Orders even though Sales' own
// analogous batch-fetch check still returns 400 for a missing/cross-
// business product; fixing that asymmetry in Sales is a separate, later
// exercise, not bundled into this module) and is active, computes each
// line's total, and returns the resolved rows ready to insert plus the
// summed PO total.
//
// unitCostSnapshot is interpreted as the NEGOTIATED purchase price the
// business is agreeing to pay this supplier for this order -- client-
// supplied, not auto-derived from the product's own cost_price -- since a
// real Purchase Order exists specifically to record what was actually
// agreed for THIS order, which can legitimately differ from the product's
// catalog cost_price (supplier-specific pricing, negotiated discounts,
// etc.). productNameSnapshot/skuSnapshot ARE auto-derived from the
// product's current values, matching costPriceAtSale's exact behavior.
// Flagging this interpretation explicitly: the locked requirement's
// wording ("same principle as costPriceAtSale") could also be read as
// "auto-derive unitCostSnapshot from product.cost_price too" -- this
// implementation takes the more business-realistic reading. Either way,
// once written, no later Product change can ever retroactively alter it.
async function resolveLineItems(
  items: { productId: string; quantityOrdered: number; unitCostSnapshot: number }[],
  businessId: string
): Promise<{ lines: ResolvedLine[]; total: Prisma.Decimal }> {
  const productIds = [...new Set(items.map((i) => i.productId))];
  const products = await prisma.products.findMany({ where: { id: { in: productIds }, business_id: businessId } });
  const productMap = new Map(products.map((p) => [p.id, p]));

  let total = new Prisma.Decimal(0);
  const lines: ResolvedLine[] = items.map((item) => {
    const product = assertOwned(productMap.get(item.productId), businessId, "Product");
    if (product.status !== "active") {
      throw badRequest(`Product "${product.name}" is archived`);
    }
    const quantity = new Prisma.Decimal(item.quantityOrdered);
    const unitCost = new Prisma.Decimal(item.unitCostSnapshot);
    const lineTotal = quantity.times(unitCost).toDecimalPlaces(2);
    total = total.plus(lineTotal);
    return {
      product_id: product.id,
      product_name_snapshot: product.name,
      sku_snapshot: product.sku,
      quantity_ordered: quantity,
      unit_cost_snapshot: unitCost,
      line_total: lineTotal,
    };
  });

  return { lines, total };
}

export async function createPurchaseOrder(input: CreatePurchaseOrderInput, actor: Actor, idempotencyKey: string) {
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });

  // Explicit cross-business rejection on every reference (supplier/branch),
  // per the user's own requirement -- getOwned is the tool, called out
  // directly rather than left as an unstated assumption.
  const supplier = await getOwned(prisma.suppliers.findUnique({ where: { id: input.supplierId } }), actor.businessId, "Supplier");
  if (supplier.status !== "active") {
    throw badRequest("Cannot create a purchase order against an archived supplier");
  }
  if (input.branchId) {
    const branch = await getOwned(prisma.branches.findUnique({ where: { id: input.branchId } }), actor.businessId, "Branch");
    if (branch.status !== "active") {
      throw badRequest("Cannot create a purchase order against an archived branch");
    }
  }

  const { lines, total } = await resolveLineItems(input.items, actor.businessId);
  const currency = getCurrency(business.currency);

  const po = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_PO_ENDPOINT);

    const poNumber = await getNextPurchaseOrderNumber(tx, actor.businessId);

    const created = await tx.purchase_orders.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        branch_id: input.branchId,
        supplier_id: supplier.id,
        supplier_name_snapshot: supplier.name,
        supplier_phone_snapshot: supplier.phone,
        supplier_email_snapshot: supplier.email,
        po_number: poNumber,
        status: "draft",
        currency_code: currency?.code ?? business.currency,
        exchange_rate: input.exchangeRate,
        total_expected_value: total,
        // Module 11 Session B -- nothing owed until a payment is recorded,
        // so remaining_amount starts equal to the full expected value
        // (paid_amount/payment_status keep their DB defaults of 0/"unpaid").
        remaining_amount: total,
        created_by: actor.userId,
      },
    });

    for (const line of lines) {
      await tx.purchase_order_items.create({
        data: { id: generateId(), business_id: actor.businessId, purchase_order_id: created.id, ...line },
      });
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.created",
      entityType: "purchase_order",
      entityId: created.id,
      reason: `Purchase order ${poNumber} created for supplier "${supplier.name}", ${total.toString()} ${created.currency_code}`,
    });

    const responseBody = JSON.parse(
      JSON.stringify({ data: await tx.purchase_orders.findUniqueOrThrow({ where: { id: created.id }, include: PO_ITEMS_INCLUDE }) })
    ) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_PO_ENDPOINT, 201, responseBody);

    return created;
  }, PO_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderCreated", {
    businessId: actor.businessId,
    purchaseOrderId: po.id,
    poNumber: po.po_number,
    supplierId: po.supplier_id,
    totalExpectedValue: po.total_expected_value.toString(),
  });

  return prisma.purchase_orders.findUniqueOrThrow({ where: { id: po.id }, include: PO_ITEMS_INCLUDE });
}

export async function listPurchaseOrders(query: ListPurchaseOrdersQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["created_at", "po_number", "total_expected_value"] as const,
    defaultSort: "created_at" as const,
  });

  const where: Prisma.purchase_ordersWhereInput = {
    business_id: businessId,
    ...(query.status ? { status: query.status } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.purchase_orders.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.purchase_orders.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

export async function getPurchaseOrder(id: string, businessId: string) {
  return getOwned(prisma.purchase_orders.findUnique({ where: { id }, include: PO_ITEMS_INCLUDE }), businessId, "Purchase order");
}

// PATCH is DRAFT-only in the fullest sense (Somali clarification): no line
// items, supplier, branch, currency, or snapshot may ever be modified once
// the PO leaves DRAFT. Enforced by construction -- the atomic guarded
// update below includes `status: "draft"` in its own WHERE, exactly like
// send/confirm/cancel, not a separate, weaker check that could rot.
export async function updatePurchaseOrder(id: string, input: UpdatePurchaseOrderInput, actor: Actor) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id } }), actor.businessId, "Purchase order");
  if (po.status !== "draft") {
    throw badRequest("Only DRAFT purchase orders can be edited");
  }

  let supplierSnapshot: { name: string; phone: string | null; email: string | null } | null = null;
  if (input.supplierId !== undefined && input.supplierId !== po.supplier_id) {
    const supplier = await getOwned(prisma.suppliers.findUnique({ where: { id: input.supplierId } }), actor.businessId, "Supplier");
    if (supplier.status !== "active") {
      throw badRequest("Cannot assign an archived supplier to a purchase order");
    }
    supplierSnapshot = { name: supplier.name, phone: supplier.phone, email: supplier.email };
  }
  if (input.branchId) {
    const branch = await getOwned(prisma.branches.findUnique({ where: { id: input.branchId } }), actor.businessId, "Branch");
    if (branch.status !== "active") {
      throw badRequest("Cannot assign an archived branch to a purchase order");
    }
  }

  let resolvedItems: { lines: ResolvedLine[]; total: Prisma.Decimal } | null = null;
  if (input.items) {
    resolvedItems = await resolveLineItems(input.items, actor.businessId);
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (resolvedItems) {
      await tx.purchase_order_items.deleteMany({ where: { purchase_order_id: id } });
      for (const line of resolvedItems.lines) {
        await tx.purchase_order_items.create({ data: { id: generateId(), business_id: actor.businessId, purchase_order_id: id, ...line } });
      }
    }

    const updateResult = await tx.purchase_orders.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "draft" },
      data: {
        ...(input.supplierId !== undefined ? { supplier_id: input.supplierId } : {}),
        ...(supplierSnapshot
          ? { supplier_name_snapshot: supplierSnapshot.name, supplier_phone_snapshot: supplierSnapshot.phone, supplier_email_snapshot: supplierSnapshot.email }
          : {}),
        ...(input.branchId !== undefined ? { branch_id: input.branchId } : {}),
        ...(input.exchangeRate !== undefined ? { exchange_rate: input.exchangeRate } : {}),
        ...(resolvedItems ? { total_expected_value: resolvedItems.total } : {}),
        version: { increment: 1 },
      },
    });
    if (updateResult.count === 0) {
      throw conflict("Purchase order is no longer DRAFT, or was modified concurrently -- please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.updated",
      entityType: "purchase_order",
      entityId: id,
      reason: `Purchase order ${po.po_number} updated`,
    });

    return tx.purchase_orders.findUniqueOrThrow({ where: { id }, include: PO_ITEMS_INCLUDE });
  }, PO_TRANSACTION_OPTIONS);

  // No PurchaseOrderUpdated domain event -- audit-log only, matching the
  // locked spec's own asymmetric Created/Sent/Confirmed/Updated/Cancelled
  // (audit, 5) vs Created/Sent/Confirmed/Cancelled (events, 4) lists.
  return updated;
}

export async function sendPurchaseOrder(id: string, input: SendPurchaseOrderInput, actor: Actor, idempotencyKey: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id } }), actor.businessId, "Purchase order");

  const updated = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, sendPurchaseOrderEndpoint(id));

    const result = await tx.purchase_orders.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "draft" },
      data: { status: "sent", version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw conflict("Purchase order is not in a sendable state (already sent/confirmed/cancelled, or was modified concurrently)");
    }

    const updatedPo = await tx.purchase_orders.findUniqueOrThrow({ where: { id } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.sent",
      entityType: "purchase_order",
      entityId: id,
      reason: `Purchase order ${updatedPo.po_number} sent`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updatedPo })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, sendPurchaseOrderEndpoint(id), 200, responseBody);
    return updatedPo;
  }, PO_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderSent", { businessId: actor.businessId, purchaseOrderId: id, poNumber: updated.po_number });
  return updated;
}

export async function confirmPurchaseOrder(id: string, input: ConfirmPurchaseOrderInput, actor: Actor, idempotencyKey: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id } }), actor.businessId, "Purchase order");

  const updated = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, confirmPurchaseOrderEndpoint(id));

    const result = await tx.purchase_orders.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "sent" },
      data: { status: "confirmed", version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw conflict("Purchase order is not in a confirmable state (must be SENT; already confirmed/cancelled, still DRAFT, or was modified concurrently)");
    }
    // PO Negotiation Session 1 -- CONFIRMED is a terminal negotiation state
    // (Workflow Guard, Enhancement #10); auto-expire any still-active secure
    // link in the same transaction as the status transition, not a scheduler.
    await expireSecureLinksForTerminalPo(tx, id);

    const updatedPo = await tx.purchase_orders.findUniqueOrThrow({ where: { id } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.confirmed",
      entityType: "purchase_order",
      entityId: id,
      reason: `Purchase order ${updatedPo.po_number} confirmed`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updatedPo })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, confirmPurchaseOrderEndpoint(id), 200, responseBody);
    return updatedPo;
  }, PO_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderConfirmed", { businessId: actor.businessId, purchaseOrderId: id, poNumber: updated.po_number });
  return updated;
}

// Requirement #7 (locked): only DRAFT or SENT may be cancelled -- CONFIRMED
// can never be cancelled this session (a future GRN-reversal path handles
// that). Guard accepts status IN (draft, sent), not a single value.
export async function cancelPurchaseOrder(id: string, input: CancelPurchaseOrderInput, actor: Actor, idempotencyKey: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id } }), actor.businessId, "Purchase order");

  const updated = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, cancelPurchaseOrderEndpoint(id));

    const result = await tx.purchase_orders.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: { in: ["draft", "sent"] } },
      data: { status: "cancelled", cancel_reason: input.reason, version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw conflict("Purchase order cannot be cancelled (must be DRAFT or SENT; already confirmed/cancelled, or was modified concurrently)");
    }
    // PO Negotiation Session 1 -- CANCELLED is a terminal negotiation state,
    // same reasoning as confirmPurchaseOrder's own call.
    await expireSecureLinksForTerminalPo(tx, id);

    const updatedPo = await tx.purchase_orders.findUniqueOrThrow({ where: { id } });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.cancelled",
      entityType: "purchase_order",
      entityId: id,
      reason: input.reason,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: updatedPo })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, cancelPurchaseOrderEndpoint(id), 200, responseBody);
    return updatedPo;
  }, PO_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderCancelled", { businessId: actor.businessId, purchaseOrderId: id, poNumber: updated.po_number, reason: input.reason });
  return updated;
}
