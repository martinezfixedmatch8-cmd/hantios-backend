import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createCustomerSchema,
  updateCustomerSchema,
  listCustomersQuerySchema,
  archiveCustomerSchema,
  restoreCustomerSchema,
  customerTimelineQuerySchema,
} from "../validation/customer.schema";
import { idParamSchema } from "../validation/common.schema";
import * as customerService from "../services/customer.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

function getIdempotencyKey(req: Request): string {
  return req.idempotencyKey as string; // guaranteed by requireIdempotencyKey
}

export async function createCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, customerService.CREATE_CUSTOMER_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createCustomerSchema.parse(req.body);
    const customer = await customerService.createCustomer(input, actor, idempotencyKey);
    res.status(201).json({ data: customer });
  } catch (err) {
    next(err);
  }
}

export async function listCustomers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listCustomersQuerySchema.parse(req.query);
    const result = await customerService.listCustomers(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const customer = await customerService.getCustomer(id, req.auth.businessId);
    res.status(200).json({ data: customer });
  } catch (err) {
    next(err);
  }
}

export async function getCustomerTimeline(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const query = customerTimelineQuerySchema.parse(req.query);
    // Deliberate exception to the {data, pagination} envelope every other
    // list endpoint in this module uses -- see customer.service.ts.
    const result = await customerService.getCustomerTimeline(id, req.auth.businessId, query);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = updateCustomerSchema.parse(req.body);
    // No Idempotency-Key on this endpoint (per the locked endpoint list) --
    // safe without one anyway, since it's version-guarded: a byte-identical
    // retry after a successful first attempt carries a now-stale version and
    // cleanly 409s on its own.
    const customer = await customerService.updateCustomer(id, input, actor);
    res.status(200).json({ data: customer });
  } catch (err) {
    next(err);
  }
}

export async function archiveCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = getIdempotencyKey(req);

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, customerService.archiveCustomerEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = archiveCustomerSchema.parse(req.body);
    const customer = await customerService.archiveCustomer(id, input, actor, idempotencyKey);
    res.status(200).json({ data: customer });
  } catch (err) {
    next(err);
  }
}

export async function restoreCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = restoreCustomerSchema.parse(req.body);
    // No Idempotency-Key (per the locked endpoint list) -- version-guarded,
    // and the partial unique index is the real guard against a concurrent
    // duplicate-active-phone race.
    const customer = await customerService.restoreCustomer(id, input, actor);
    res.status(200).json({ data: customer });
  } catch (err) {
    next(err);
  }
}
