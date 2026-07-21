import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { CSRF_COOKIE_NAME } from "../lib/session";
import { forbidden } from "../lib/errors";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Double-submit CSRF check for the two endpoints that act on the ambient httpOnly
// refresh_token cookie (refresh, logout). The csrf_token cookie is readable by JS on the
// API's own origin; a cross-site request can't read it to produce a matching header.
export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.get("x-csrf-token");

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    next(forbidden("Missing or invalid CSRF token"));
    return;
  }
  next();
}
