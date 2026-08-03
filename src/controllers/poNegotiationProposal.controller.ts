import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { idParamSchema } from "../validation/common.schema";
import {
  draftProposalSchema,
  submitProposalSchema,
  rejectProposalSchema,
  listProposalsQuerySchema,
} from "../validation/poNegotiationProposal.schema";
import * as proposalService from "../services/poNegotiationProposal.service";
import { getReplayedResponse } from "../lib/idempotency";
import { getOwnerNegotiationActor } from "../lib/negotiationActor";
import { unauthorized } from "../lib/errors";

const proposalIdParamSchema = z.object({ id: z.string().uuid(), proposalId: z.string().uuid() });

export async function saveDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id } = idParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, proposalService.draftProposalEndpoint(id));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = draftProposalSchema.parse(req.body);
    const proposal = await proposalService.saveDraft(id, input, actor, idempotencyKey);
    res.status(200).json({ data: proposal });
  } catch (err) {
    next(err);
  }
}

export async function submitProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id, proposalId } = proposalIdParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, proposalService.submitProposalEndpoint(id, proposalId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = submitProposalSchema.parse(req.body);
    const proposal = await proposalService.submitProposal(id, proposalId, input.version, actor, idempotencyKey);
    res.status(200).json({ data: proposal });
  } catch (err) {
    next(err);
  }
}

export async function acceptProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id, proposalId } = proposalIdParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, proposalService.acceptProposalEndpoint(id, proposalId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const result = await proposalService.acceptProposal(id, proposalId, actor, idempotencyKey);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function rejectProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const actor = getOwnerNegotiationActor(req);
    const { id, proposalId } = proposalIdParamSchema.parse(req.params);
    const idempotencyKey = req.idempotencyKey as string;

    const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, proposalService.rejectProposalEndpoint(id, proposalId));
    if (replayed) {
      res.status(replayed.status).json(replayed.body);
      return;
    }

    const input = rejectProposalSchema.parse(req.body);
    const proposal = await proposalService.rejectProposal(id, proposalId, input, actor, idempotencyKey);
    res.status(200).json({ data: proposal });
  } catch (err) {
    next(err);
  }
}

export async function listProposals(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const query = listProposalsQuerySchema.parse(req.query);
    const result = await proposalService.listProposals(id, query, "owner", req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
