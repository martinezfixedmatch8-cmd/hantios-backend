import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";

// Batch 8 Session B (HNT-OBS-001) -- the very first middleware in the chain
// (mounted before helmet/cors/the raw-body webhook route/express.json in
// app.ts), so every request -- including the one route that never touches
// express.json() -- gets a correlation id and an accurate end-to-end
// duration measurement from the logging middleware that follows it.
//
// An inbound X-Request-Id is trusted only after passing a strict allowlist
// regex -- never logged or echoed raw before validation. Rejecting an
// invalid header value outright (falling back to a fresh UUID) instead of
// e.g. truncating/sanitizing it closes a log-injection/correlation-abuse
// vector: a malicious client could otherwise embed newlines, control
// characters, or an ID crafted to collide with another request's own
// correlation id.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("X-Request-Id");
  req.requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}
