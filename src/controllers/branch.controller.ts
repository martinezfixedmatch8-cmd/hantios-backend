import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { createBranchSchema, updateBranchSchema, listBranchesQuerySchema } from "../validation/branch.schema";
import { idParamSchema } from "../validation/common.schema";
import * as branchService from "../services/branch.service";

function getActor(req: Request) {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

export async function createBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createBranchSchema.parse(req.body);
    const branch = await branchService.createBranch(input, getActor(req));
    res.status(201).json({ data: branch });
  } catch (err) {
    next(err);
  }
}

export async function listBranches(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = listBranchesQuerySchema.parse(req.query);
    const result = await branchService.listBranches(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const { id } = idParamSchema.parse(req.params);
    const branch = await branchService.getBranch(id, req.auth.businessId);
    res.status(200).json({ data: branch });
  } catch (err) {
    next(err);
  }
}

export async function updateBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = idParamSchema.parse(req.params);
    const input = updateBranchSchema.parse(req.body);
    const branch = await branchService.updateBranch(id, input, getActor(req));
    res.status(200).json({ data: branch });
  } catch (err) {
    next(err);
  }
}

export async function archiveBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = idParamSchema.parse(req.params);
    const branch = await branchService.archiveBranch(id, getActor(req));
    res.status(200).json({ data: branch });
  } catch (err) {
    next(err);
  }
}

export async function restoreBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = idParamSchema.parse(req.params);
    const branch = await branchService.restoreBranch(id, getActor(req));
    res.status(200).json({ data: branch });
  } catch (err) {
    next(err);
  }
}
