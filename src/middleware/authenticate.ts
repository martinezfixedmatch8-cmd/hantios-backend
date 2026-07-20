import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/jwt";
import { unauthorized } from "../lib/errors";

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    next(unauthorized());
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub, businessId: payload.businessId, role: payload.role };
    next();
  } catch {
    next(unauthorized());
  }
}
