import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getOwned } from "../lib/ownership";
import { badRequest } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { getOrCreateWarehouse } from "../lib/warehouse";
import { recordWarehouseMovement } from "../lib/warehouseStock";
import { generateReceiptInTransaction, buildWarehouseStockOutReceiptSnapshot } from "./receipt.service";
import type { StockInInput, StockOutInput } from "../validation/warehouseMovement.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Same Neon-latency reasoning as Sales'/Stock-Adjustment's/Purchase Orders'
// own transaction timeouts -- a counter allocation + warehouse_stock write +
// warehouse_movements insert + audit log + idempotency completion is
// several sequential round trips deep.
const WAREHOUSE_MOVEMENT_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

export const STOCK_IN_ENDPOINT = "POST /warehouse-movements/stock-in";
export const STOCK_OUT_ENDPOINT = "POST /warehouse-movements/stock-out";

export async function stockIn(input: StockInInput, actor: Actor, idempotencyKey: string) {
  const product = await getOwned(prisma.products.findUnique({ where: { id: input.productId } }), actor.businessId, "Product");
  if (product.status !== "active") throw badRequest("Cannot stock in an archived product");

  const quantity = new Prisma.Decimal(input.quantity);
  const unitCost = new Prisma.Decimal(input.unitCost);

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, STOCK_IN_ENDPOINT);

    // Exactly one warehouse per business, resolved internally -- no
    // warehouseId is ever accepted from a client (see src/lib/warehouse.ts).
    const warehouse = await getOrCreateWarehouse(tx, actor.businessId);

    const { movement, quantityAfter } = await recordWarehouseMovement(tx, {
      businessId: actor.businessId,
      warehouseId: warehouse.id,
      productId: product.id,
      quantity,
      movementType: "stock_in",
      grnId: null,
      unitCost,
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "warehouse_movement.stock_in",
      entityType: "warehouse_movement",
      entityId: movement.id,
      reason: `Stock In ${movement.movement_number}: ${quantity.toString()} of "${product.name}" (now ${quantityAfter.toString()})`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: movement })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, STOCK_IN_ENDPOINT, 201, responseBody);

    return movement;
  }, WAREHOUSE_MOVEMENT_TRANSACTION_OPTIONS);

  domainEvents.publish("WarehouseStockIn", {
    businessId: actor.businessId,
    warehouseId: result.warehouse_id,
    productId: result.product_id,
    movementNumber: result.movement_number,
    quantity: quantity.toString(),
  });

  return result;
}

export async function stockOut(input: StockOutInput, actor: Actor, idempotencyKey: string) {
  const product = await getOwned(prisma.products.findUnique({ where: { id: input.productId } }), actor.businessId, "Product");
  if (product.status !== "active") throw badRequest("Cannot stock out an archived product");

  if (input.destinationBranchId) {
    const destinationBranch = await getOwned(
      prisma.branches.findUnique({ where: { id: input.destinationBranchId } }),
      actor.businessId,
      "Branch"
    );
    if (destinationBranch.status !== "active") throw badRequest("Cannot transfer stock to an archived branch");
  }

  const quantity = new Prisma.Decimal(input.quantity);
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  const destinationBranchName = input.destinationBranchId
    ? (await getOwned(prisma.branches.findUnique({ where: { id: input.destinationBranchId } }), actor.businessId, "Branch")).name
    : null;

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, STOCK_OUT_ENDPOINT);

    const warehouse = await getOrCreateWarehouse(tx, actor.businessId);

    // This row is ALSO the minimal "Stock Out Receipt" the schema's own
    // comment on warehouse_movements.destination_branch_id anticipated --
    // Module 06 now supersedes it for real with a genuine structured
    // Warehouse Stock Out Receipt below, generated inside this same
    // transaction. branch_inventory itself is still deliberately untouched
    // even for branch_transfer, unrelated to receipts.
    const { movement, quantityAfter } = await recordWarehouseMovement(tx, {
      businessId: actor.businessId,
      warehouseId: warehouse.id,
      productId: product.id,
      quantity,
      movementType: "stock_out",
      destinationBranchId: input.destinationBranchId ?? null,
      reason: input.reason,
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });

    const stockOutReceipt = await generateReceiptInTransaction(tx, {
      businessId: actor.businessId,
      timezone: business.timezone,
      settings: business.settings,
      currencyCode: business.currency,
      receiptType: "warehouse_stock_out",
      source: { warehouseMovementId: movement.id },
      subtotal: 0,
      total: 0,
      snapshot: buildWarehouseStockOutReceiptSnapshot(
        business,
        [{ productName: product.name, size: null, quantity: quantity.toString(), unitPrice: "0", lineTotal: "0" }],
        { warehouseName: warehouse.name, destinationBranchName, movementNumber: movement.movement_number }
      ),
      createdBy: actor.userId,
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "warehouse_movement.stock_out",
      entityType: "warehouse_movement",
      entityId: movement.id,
      reason: `Stock Out ${movement.movement_number}: ${quantity.toString()} of "${product.name}" (${input.reason}, now ${quantityAfter.toString()})`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: movement })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, STOCK_OUT_ENDPOINT, 201, responseBody);

    return { movement, stockOutReceipt };
  }, WAREHOUSE_MOVEMENT_TRANSACTION_OPTIONS);
  const { movement: stockOutMovement, stockOutReceipt } = result;

  domainEvents.publish("WarehouseStockOut", {
    businessId: actor.businessId,
    warehouseId: stockOutMovement.warehouse_id,
    productId: stockOutMovement.product_id,
    movementNumber: stockOutMovement.movement_number,
    quantity: quantity.toString(),
  });
  domainEvents.publish("ReceiptGenerated", {
    businessId: actor.businessId,
    receiptId: stockOutReceipt.id,
    receiptNumber: stockOutReceipt.receipt_number,
    receiptType: stockOutReceipt.receipt_type,
  });

  return stockOutMovement;
}
