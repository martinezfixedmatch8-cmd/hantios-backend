import type { Request, Response, NextFunction } from "express";
import { logRequest } from "../lib/logger";

// Batch 8 Session B (HNT-OBS-001) -- mounted immediately after requestId.ts,
// before helmet/cors/the raw-body webhook route/express.json, so duration
// measurement covers the full request lifecycle for every route including
// the one that never touches express.json().
//
// req.auth is read inside the `finish` callback, not at middleware-entry
// time -- by the time a response actually finishes, every downstream
// middleware (including whichever route's own `authenticate`) has already
// run, so req.auth?.businessId is correctly populated here for an
// authenticated request and correctly absent for a pre-auth/public one.
export function requestLogging(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    logRequest({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      requestId: req.requestId ?? "unknown",
      businessId: req.auth?.businessId,
    });
  });
  next();
}
