import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { idParamSchema } from "../validation/common.schema";
import { supersedeCommercialInvoiceSchema, listCommercialInvoicesQuerySchema } from "../validation/poCommercialInvoice.schema";
import * as service from "../services/poCommercialInvoice.service";
import { getReplayedResponse } from "../lib/idempotency";
import { unauthorized } from "../lib/errors";

const invoiceIdParamSchema = z.object({ id: z.string().uuid(), invoiceId: z.string().uuid() });

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function issueCommercialInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.issueCommercialInvoiceEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const result = await service.issueCommercialInvoice(id, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function supersedeCommercialInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id, invoiceId } = invoiceIdParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.supersedeCommercialInvoiceEndpoint(id, invoiceId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = supersedeCommercialInvoiceSchema.parse(req.body);
    const result = await service.supersedeCommercialInvoice(id, invoiceId, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listCommercialInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const query = listCommercialInvoicesQuerySchema.parse(req.query);
    const result = await service.listCommercialInvoices(id, query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPaymentStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const result = await service.getPaymentStatus(id, req.auth.businessId);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}
