import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@prisma/client";
import { forbidden, unauthorized } from "../lib/errors";

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(unauthorized());
      return;
    }
    if (req.auth.role === "super_admin" || roles.includes(req.auth.role)) {
      next();
      return;
    }
    next(forbidden());
  };
}
