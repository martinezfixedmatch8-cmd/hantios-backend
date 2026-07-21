import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import {
  createPaymentMethodSchema,
  updatePaymentMethodSchema,
  listPaymentMethodsQuerySchema,
} from "../validation/paymentMethod.schema";
import { idParamSchema } from "../validation/common.schema";
import * as paymentMethodService from "../services/paymentMethod.service";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createPaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createPaymentMethodSchema.parse(req.body);
    const paymentMethod = await paymentMethodService.createPaymentMethod(input, getActor(req));
    res.status(201).json({ data: paymentMethod });
  } catch (err) {
    next(err);
  }
}

export async function listPaymentMethods(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listPaymentMethodsQuerySchema.parse(req.query);
    const result = await paymentMethodService.listPaymentMethods(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const paymentMethod = await paymentMethodService.getPaymentMethod(id, req.auth.businessId);
    res.status(200).json({ data: paymentMethod });
  } catch (err) {
    next(err);
  }
}

export async function updatePaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = idParamSchema.parse(req.params);
    const input = updatePaymentMethodSchema.parse(req.body);
    const paymentMethod = await paymentMethodService.updatePaymentMethod(id, input, getActor(req));
    res.status(200).json({ data: paymentMethod });
  } catch (err) {
    next(err);
  }
}

export async function archivePaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = idParamSchema.parse(req.params);
    const paymentMethod = await paymentMethodService.archivePaymentMethod(id, getActor(req));
    res.status(200).json({ data: paymentMethod });
  } catch (err) {
    next(err);
  }
}

export async function restorePaymentMethod(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = idParamSchema.parse(req.params);
    const paymentMethod = await paymentMethodService.restorePaymentMethod(id, getActor(req));
    res.status(200).json({ data: paymentMethod });
  } catch (err) {
    next(err);
  }
}
