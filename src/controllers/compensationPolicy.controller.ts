import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { idParamSchema } from "../validation/common.schema";
import {
  createCompensationPolicySchema,
  listCompensationPoliciesQuerySchema,
  acknowledgeCompensationPolicySchema,
} from "../validation/compensationPolicy.schema";
import * as policyService from "../services/compensationPolicy.service";
import { getReplayedResponse } from "../lib/idempotency";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createCompensationPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const idempotencyKey = req.idempotencyKey as string; // guaranteed by requireIdempotencyKey

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, policyService.CREATE_COMPENSATION_POLICY_ENDPOINT);
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = createCompensationPolicySchema.parse(req.body);
    const result = await policyService.createCompensationPolicy(input, actor, idempotencyKey);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function listCompensationPolicies(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listCompensationPoliciesQuerySchema.parse(req.query);
    const result = await policyService.listCompensationPolicies(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getCompensationPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const result = await policyService.getCompensationPolicy(id, req.auth.businessId);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function acknowledgeCompensationPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actor = getActor(req);
    const { id } = idParamSchema.parse(req.params);
    const input = acknowledgeCompensationPolicySchema.parse(req.body);
    const result = await policyService.acknowledgeCompensationPolicy(id, input, actor);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
}
