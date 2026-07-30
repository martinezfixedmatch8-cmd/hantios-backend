import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createSupplierSchema,
  updateSupplierSchema,
  listSuppliersQuerySchema,
  archiveSupplierSchema,
  restoreSupplierSchema,
} from "../validation/supplier.schema";
import { idParamSchema } from "../validation/common.schema";
import * as supplierService from "../services/supplier.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function createSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, supplierService.CREATE_SUPPLIER_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createSupplierSchema.parse(req.body);
    const supplier = await supplierService.createSupplier(input, actor, idempotencyKey);
    res.status(201).json({ data: supplier });
  } catch (err) {
    next(err);
  }
}

export async function listSuppliers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listSuppliersQuerySchema.parse(req.query);
    const result = await supplierService.listSuppliers(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const supplier = await supplierService.getSupplier(id, req.auth.businessId);
    res.status(200).json({ data: supplier });
  } catch (err) {
    next(err);
  }
}

export async function updateSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = updateSupplierSchema.parse(req.body);
    const supplier = await supplierService.updateSupplier(id, input, actor);
    res.status(200).json({ data: supplier });
  } catch (err) {
    next(err);
  }
}

export async function archiveSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, supplierService.archiveSupplierEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = archiveSupplierSchema.parse(req.body);
    const supplier = await supplierService.archiveSupplier(id, input, actor, idempotencyKey);
    res.status(200).json({ data: supplier });
  } catch (err) {
    next(err);
  }
}

export async function restoreSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = restoreSupplierSchema.parse(req.body);
    const supplier = await supplierService.restoreSupplier(id, input, actor);
    res.status(200).json({ data: supplier });
  } catch (err) {
    next(err);
  }
}
