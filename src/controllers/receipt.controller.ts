import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { idParamSchema } from "../validation/common.schema";
import { listReceiptsQuerySchema, requestReceiptDeliverySchema } from "../validation/receipt.schema";
import * as receiptService from "../services/receipt.service";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function listReceipts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const query = listReceiptsQuerySchema.parse(req.query);
    const result = await receiptService.listReceipts(query, actor);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getReceipt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const result = await receiptService.getReceipt(id, actor);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listDeliveryAttempts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const result = await receiptService.listDeliveryAttempts(id, actor);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function requestReceiptDelivery(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);
    const input = requestReceiptDeliverySchema.parse(req.body);

    // Local Layer-1 (request idempotency, with payload-hash comparison --
    // see receipt.service.ts's own header comment for why this is a
    // Module-06-local addition, not a change to the shared primitive) +
    // Layer-2 (source/business uniqueness -- N/A here, delivery isn't a
    // source-event, every explicit request is legitimate).
    const replayed = await receiptService.checkDeliveryIdempotentReplay(actor.businessId, idempotencyKey, id, input);
    if (replayed) {
      // replayed.body is the unwrapped attempt object (checkDeliveryIdempotentReplay
      // strips _payloadHash for its own comparison) -- re-wrap to match the
      // fresh-response envelope shape exactly, so a replay is byte-identical
      // to the original from the client's own point of view.
      res.status(replayed.status).json({ data: replayed.body });
      return;
    }

    const result = await receiptService.requestReceiptDelivery(id, input, actor, idempotencyKey);
    const { _payloadHash, ...responseData } = result;
    await receiptService.completeDeliveryIdempotencyKey(actor.businessId, idempotencyKey, id, 201, { data: responseData, _payloadHash });
    res.status(201).json({ data: responseData });
  } catch (err) {
    next(err);
  }
}
