import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { createSaleSchema, listSalesQuerySchema, voidSaleSchema, refundSaleSchema, setSaleAttributionSchema } from "../validation/sale.schema";
import { idParamSchema } from "../validation/common.schema";
import * as saleService from "../services/sale.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createSale(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = req.idempotencyKey as string; // guaranteed by requireIdempotencyKey

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, saleService.CREATE_SALE_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createSaleSchema.parse(req.body);
    const sale = await saleService.createSale(input, actor, idempotencyKey);
    res.status(201).json({ data: sale });
  } catch (err) {
    next(err);
  }
}

export async function voidSale(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string; // guaranteed by requireIdempotencyKey

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, saleService.voidSaleEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = voidSaleSchema.parse(req.body);
    const sale = await saleService.voidSale(id, input, actor, idempotencyKey);
    res.status(200).json({ data: sale });
  } catch (err) {
    next(err);
  }
}

export async function refundSale(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string; // guaranteed by requireIdempotencyKey

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, saleService.refundSaleEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = refundSaleSchema.parse(req.body);
    const refund = await saleService.refundSale(id, input, actor, idempotencyKey);
    res.status(201).json({ data: refund });
  } catch (err) {
    next(err);
  }
}

export async function setSaleAttribution(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string; // guaranteed by requireIdempotencyKey

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, saleService.setSaleAttributionEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = setSaleAttributionSchema.parse(req.body);
    const sale = await saleService.setSaleAttribution(id, input, actor, idempotencyKey);
    res.status(200).json({ data: sale });
  } catch (err) {
    next(err);
  }
}

export async function listSales(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listSalesQuerySchema.parse(req.query);
    const result = await saleService.listSales(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getSale(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const sale = await saleService.getSale(id, req.auth.businessId);
    res.status(200).json({ data: sale });
  } catch (err) {
    next(err);
  }
}
