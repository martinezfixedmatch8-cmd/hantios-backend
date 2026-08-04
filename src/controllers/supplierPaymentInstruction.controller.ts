import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { createSupplierPaymentInstructionSchema } from "../validation/supplierPaymentInstruction.schema";
import { paginationQuerySchema } from "../lib/pagination";
import * as service from "../services/supplierPaymentInstruction.service";
import { getReplayedResponse } from "../lib/idempotency";
import { unauthorized } from "../lib/errors";

const supplierIdParamSchema = z.object({ supplierId: z.string().uuid() });
const instructionIdParamSchema = z.object({ supplierId: z.string().uuid(), id: z.string().uuid() });

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function createSupplierPaymentInstruction(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { supplierId } = supplierIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.createSupplierPaymentInstructionEndpoint(supplierId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createSupplierPaymentInstructionSchema.parse(req.body);
    const result = await service.createSupplierPaymentInstruction(supplierId, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listSupplierPaymentInstructions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { supplierId } = supplierIdParamSchema.parse(req.params);
    const query = paginationQuerySchema.parse(req.query);
    const result = await service.listSupplierPaymentInstructions(supplierId, query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function setDefaultSupplierPaymentInstruction(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { supplierId, id } = instructionIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.setDefaultSupplierPaymentInstructionEndpoint(supplierId, id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const result = await service.setDefaultSupplierPaymentInstruction(supplierId, id, actor, idempotencyKey);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}
