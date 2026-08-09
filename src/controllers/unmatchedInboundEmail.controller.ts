import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../lib/errors";
import { paginationQuerySchema } from "../lib/pagination";
import { listUnmatchedInboundEmails } from "../services/unmatchedInboundEmail.service";

export async function listUnmatchedInboundEmailsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const query = paginationQuerySchema.parse(req.query);
    const result = await listUnmatchedInboundEmails(query, req.auth.businessId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
