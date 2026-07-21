import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest, conflict } from "../lib/errors";
import type {
  CreateProductInput,
  UpdateProductInput,
  ListProductsQuery,
  AdjustStockInput,
} from "../validation/product.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

async function assertCategoryBelongsToBusiness(categoryId: string, businessId: string): Promise<void> {
  await getOwned(prisma.categories.findUnique({ where: { id: categoryId } }), businessId, "Category");
}

export async function createProduct(input: CreateProductInput, actor: Actor) {
  if (input.categoryId) {
    await assertCategoryBelongsToBusiness(input.categoryId, actor.businessId);
  }

  const product = await prisma.products.create({
    data: {
      id: generateId(),
      business_id: actor.businessId,
      name: input.name,
      sku: input.sku,
      barcode: input.barcode,
      category_id: input.categoryId,
      cost_price: input.costPrice,
      selling_price: input.sellingPrice,
      sizes: input.sizes as Prisma.InputJsonValue,
      unit_type: input.unitType,
      packaging_hierarchy: input.packagingHierarchy as Prisma.InputJsonValue,
      min_stock_level: input.minStockLevel,
    },
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "product.created",
    entityType: "product",
    entityId: product.id,
    reason: `Product "${product.name}" created`,
  });

  return product;
}

export async function listProducts(query: ListProductsQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at", "selling_price", "cost_price"] as const,
    defaultSort: "created_at",
    searchableFields: ["name", "sku", "barcode"],
  });

  const where = {
    business_id: businessId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.categoryId ? { category_id: query.categoryId } : {}),
    ...resolved.searchWhere,
  };

  const [rows, total] = await Promise.all([
    prisma.products.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.products.count({ where }),
  ]);

  return paginate(rows, total, resolved.page, resolved.pageSize);
}

export async function getProduct(id: string, businessId: string) {
  return getOwned(prisma.products.findUnique({ where: { id } }), businessId, "Product");
}

export async function updateProduct(id: string, input: UpdateProductInput, actor: Actor) {
  const product = await getOwned(prisma.products.findUnique({ where: { id } }), actor.businessId, "Product");

  if (input.categoryId) {
    await assertCategoryBelongsToBusiness(input.categoryId, actor.businessId);
  }

  const costPriceChanging = input.costPrice !== undefined && !product.cost_price.equals(input.costPrice);
  if (costPriceChanging && !input.reason) {
    throw badRequest("A reason is required when changing the cost price");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.products.updateMany({
      where: { id, version: input.version },
      data: {
        name: input.name,
        sku: input.sku,
        barcode: input.barcode,
        category_id: input.categoryId,
        cost_price: input.costPrice,
        selling_price: input.sellingPrice,
        sizes: input.sizes as Prisma.InputJsonValue | undefined,
        unit_type: input.unitType,
        packaging_hierarchy: input.packagingHierarchy as Prisma.InputJsonValue | undefined,
        min_stock_level: input.minStockLevel,
        version: { increment: 1 },
      },
    });
    if (result.count === 0) {
      throw conflict("Product was modified concurrently, please retry with the latest version");
    }

    if (costPriceChanging) {
      await tx.price_history.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          product_id: id,
          old_price: product.cost_price,
          new_price: input.costPrice as number,
          changed_by: actor.userId,
          reason: input.reason as string,
        },
      });
    }

    return tx.products.findUniqueOrThrow({ where: { id } });
  });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "product.updated",
    entityType: "product",
    entityId: id,
    reason: costPriceChanging ? (input.reason as string) : `Product "${updated.name}" updated`,
  });

  return updated;
}

async function setProductStatus(id: string, expectedVersion: number, targetStatus: "active" | "archived", actor: Actor) {
  const product = await getOwned(prisma.products.findUnique({ where: { id } }), actor.businessId, "Product");
  if (product.status === targetStatus) {
    throw badRequest(`Product is already ${targetStatus}`);
  }

  const result = await prisma.products.updateMany({
    where: { id, version: expectedVersion },
    data: { status: targetStatus, version: { increment: 1 } },
  });
  if (result.count === 0) {
    throw conflict("Product was modified concurrently, please retry with the latest version");
  }

  const updated = await prisma.products.findUniqueOrThrow({ where: { id } });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: targetStatus === "archived" ? "product.archived" : "product.restored",
    entityType: "product",
    entityId: id,
    reason: `Product "${product.name}" ${targetStatus === "archived" ? "archived" : "restored"}`,
  });

  return updated;
}

export async function archiveProduct(id: string, expectedVersion: number, actor: Actor) {
  return setProductStatus(id, expectedVersion, "archived", actor);
}

export async function restoreProduct(id: string, expectedVersion: number, actor: Actor) {
  return setProductStatus(id, expectedVersion, "active", actor);
}

export async function adjustProductStock(productId: string, input: AdjustStockInput, actor: Actor) {
  await getOwned(prisma.products.findUnique({ where: { id: productId } }), actor.businessId, "Product");
  await getOwned(prisma.branches.findUnique({ where: { id: input.branchId } }), actor.businessId, "Branch");

  const adjustment = await prisma.$transaction(async (tx) => {
    const existing = await tx.branch_inventory.findFirst({
      where: { branch_id: input.branchId, product_id: productId, size: input.size ?? null, business_id: actor.businessId },
      orderBy: { id: "asc" },
    });

    let quantityBefore: Prisma.Decimal;
    let quantityAfter: Prisma.Decimal;

    if (!existing) {
      if (input.direction === "decrease") {
        throw conflict("No stock record exists for this product at this branch; cannot decrease");
      }
      quantityBefore = new Prisma.Decimal(0);
      quantityAfter = new Prisma.Decimal(input.quantity);

      try {
        await tx.branch_inventory.create({
          data: {
            id: generateId(),
            business_id: actor.businessId,
            branch_id: input.branchId,
            product_id: productId,
            size: input.size ?? null,
            quantity: quantityAfter,
            // Matches the schema's own @default(0) rather than hardcoding a
            // different starting value -- the first subsequent update takes it to 1.
            version: 0,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw conflict("Stock record was created concurrently, please retry");
        }
        throw err;
      }
    } else {
      quantityBefore = existing.quantity;
      quantityAfter =
        input.direction === "increase" ? existing.quantity.plus(input.quantity) : existing.quantity.minus(input.quantity);

      if (quantityAfter.lessThan(0)) {
        throw conflict("Insufficient stock for this adjustment");
      }

      const result = await tx.branch_inventory.updateMany({
        where: { id: existing.id, version: existing.version },
        data: {
          quantity: input.direction === "increase" ? { increment: input.quantity } : { decrement: input.quantity },
          version: { increment: 1 },
          last_updated: new Date(),
        },
      });
      if (result.count === 0) {
        throw conflict("Stock record changed concurrently, please retry");
      }
    }

    const created = await tx.inventory_adjustments.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        product_id: productId,
        branch_id: input.branchId,
        quantity_before: quantityBefore,
        quantity_after: quantityAfter,
        adjustment_amount: input.quantity,
        adjustment_type: input.adjustmentType,
        packaging_level: input.packagingLevel,
        reason: input.reason,
        adjusted_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "product.stock_adjusted",
      entityType: "inventory_adjustment",
      entityId: created.id,
      reason: input.reason,
    });

    return created;
  });

  return adjustment;
}
