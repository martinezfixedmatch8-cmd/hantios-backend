import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@prisma/client";
import { forbidden, unauthorized } from "./errors";

// Batch 4 remediation -- a small, scoped, semantically-named permission
// check, deliberately NOT built on top of users.permissions (that JSON
// column is confirmed dormant per this repo's own Auth Architecture:
// "present but unused, don't wire partial support for it until a real
// permissions-evaluation engine exists"). This is a real, minimal
// alternative: a permission name maps to a fixed role list, resolved the
// same way requireRole already does (role membership + the same
// super_admin bypass), just named at the call site by WHAT the caller is
// allowed to do rather than WHICH roles happen to be allowed to do it --
// exactly what "not hard-coding the role name" asks for, without building
// a general permissions-evaluation system this batch doesn't need.
const PERMISSIONS = {
  reveal_payment_instruction: ["owner", "manager"],
} as const satisfies Record<string, readonly UserRole[]>;

export type PermissionName = keyof typeof PERMISSIONS;

export function requirePermission(name: PermissionName) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(unauthorized());
      return;
    }
    const allowedRoles = PERMISSIONS[name];
    if (req.auth.role === "super_admin" || (allowedRoles as readonly UserRole[]).includes(req.auth.role)) {
      next();
      return;
    }
    next(forbidden());
  };
}
