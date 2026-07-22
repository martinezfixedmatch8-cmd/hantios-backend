import type { Request, Response, NextFunction } from "express";
import { badRequest } from "../lib/errors";

// Validation only -- matches csrf.ts's style. The actual claim/replay logic
// needs a DB transaction and lives in src/lib/idempotency.ts, called from
// each protected service (createSale first; Debt payment/Void/Refund reuse it).
export function requireIdempotencyKey(req: Request, _res: Response, next: NextFunction): void {
  const key = req.get("Idempotency-Key");
  if (!key || !key.trim()) {
    next(badRequest("Idempotency-Key header is required"));
    return;
  }
  req.idempotencyKey = key.trim();
  next();
}
