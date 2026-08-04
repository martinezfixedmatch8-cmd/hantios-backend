import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { idParamSchema } from "../validation/common.schema";
import { issueProformaInvoiceSchema, listProformaInvoicesQuerySchema } from "../validation/poProformaInvoice.schema";
import * as service from "../services/poProformaInvoice.service";
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

export async function issueProformaInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, service.issueProformaInvoiceEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = issueProformaInvoiceSchema.parse(req.body);
    const result = await service.issueProformaInvoice(id, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listProformaInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const query = listProformaInvoicesQuerySchema.parse(req.query);
    const result = await service.listProformaInvoices(id, query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getProformaInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id, invoiceId } = invoiceIdParamSchema.parse(req.params);
    const result = await service.getProformaInvoice(id, invoiceId, req.auth.businessId);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}
