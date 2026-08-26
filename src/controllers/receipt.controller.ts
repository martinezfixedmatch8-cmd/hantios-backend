import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { idParamSchema } from "../validation/common.schema";
import { listReceiptsQuerySchema, requestReceiptDeliverySchema, listDeliveryAttemptsQuerySchema } from "../validation/receipt.schema";
import * as receiptService from "../services/receipt.service";
import { getReplayedResponse } from "../lib/idempotency";

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
    const query = listDeliveryAttemptsQuerySchema.parse(req.query);
    const result = await receiptService.listDeliveryAttempts(id, actor, query);
    // HNT2-RECEIPT-001 -- the service now returns the standard {data,
    // pagination} envelope directly (matching listReceipts's own pattern
    // immediately above), so this sends it as-is. Wrapping it again in
    // { data: result } would nest as { data: { data, pagination } } instead
    // of the correct top-level { data, pagination } -- a real bug caught
    // before shipping, not a hypothetical one.
    res.status(200).json(result);
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

    // Batch 8 Session A (HNT-IDEMP-001/002) -- now the same shared
    // getReplayedResponse/claimIdempotencyKey/completeIdempotencyKey every
    // other endpoint in this repo uses, payload-hash mismatch protection
    // included. See receipt.service.ts's own header comment for the full
    // migration story.
    const replayed = await getReplayedResponse(
      actor.businessId,
      actor.userId,
      idempotencyKey,
      receiptService.requestReceiptDeliveryEndpoint(id),
      input
    );
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const result = await receiptService.requestReceiptDelivery(id, input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}
