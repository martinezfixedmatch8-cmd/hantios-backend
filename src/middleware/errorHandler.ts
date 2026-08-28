import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { logUnhandledError } from "../lib/logger";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}`, requestId: req.requestId } });
}

// Batch 8 Session B (HNT-OBS-001) -- requestId is now included on every
// error response (Zod/400, AppError/4xx, and the unexpected-500 fallback),
// not just the last one. Only the unexpected-500 fallback branch writes a
// structured log line: a ZodError/AppError is already a *handled*
// validation/business outcome (this file's own existing distinction,
// unchanged), so logging it as an "error" would just be request-shape noise
// -- matching the "do not convert ordinary handled 4xx... into noisy error
// logs" requirement. The raw `console.error(err)` this branch used to do
// (full message + stack) is gone entirely, replaced by logUnhandledError's
// own safe-message policy -- see src/lib/logger.ts for why nothing beyond
// the error's constructor name and (when present) a known-safe `.code` is
// ever logged for this branch.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: "BAD_REQUEST", message: "Validation failed", details: err.issues, requestId: req.requestId },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details, requestId: req.requestId },
    });
    return;
  }

  logUnhandledError({ requestId: req.requestId ?? "unknown", method: req.method, path: req.path }, err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong", requestId: req.requestId } });
}
