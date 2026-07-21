import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createProductSchema,
  updateProductSchema,
  listProductsQuerySchema,
  versionedActionSchema,
  adjustStockSchema,
} from "../validation/product.schema";
import { idParamSchema } from "../validation/common.schema";
import * as productService from "../services/product.service";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createProductSchema.parse(req.body);
    const product = await productService.createProduct(input, getActor(req));
    res.status(201).json({ data: product });
  } catch (err) {
    next(err);
  }
}

export async function listProducts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listProductsQuerySchema.parse(req.query);
    const result = await productService.listProducts(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const product = await productService.getProduct(id, req.auth.businessId);
    res.status(200).json({ data: product });
  } catch (err) {
    next(err);
  }
}

export async function updateProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = idParamSchema.parse(req.params);
    const input = updateProductSchema.parse(req.body);
    const product = await productService.updateProduct(id, input, getActor(req));
    res.status(200).json({ data: product });
  } catch (err) {
    next(err);
  }
}

export async function archiveProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = idParamSchema.parse(req.params);
    const { version } = versionedActionSchema.parse(req.body);
    const product = await productService.archiveProduct(id, version, getActor(req));
    res.status(200).json({ data: product });
  } catch (err) {
    next(err);
  }
}

export async function restoreProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = idParamSchema.parse(req.params);
    const { version } = versionedActionSchema.parse(req.body);
    const product = await productService.restoreProduct(id, version, getActor(req));
    res.status(200).json({ data: product });
  } catch (err) {
    next(err);
  }
}

export async function adjustStock(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = idParamSchema.parse(req.params);
    const input = adjustStockSchema.parse(req.body);
    const adjustment = await productService.adjustProductStock(id, input, getActor(req));
    res.status(201).json({ data: adjustment });
  } catch (err) {
    next(err);
  }
}
