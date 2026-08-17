import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/jwt";
import { unauthorized } from "../lib/errors";
import { prisma } from "../lib/prisma";

// Batch 2 remediation (HNT2-AUTH-001) -- was purely synchronous (decode the
// JWT, trust its claims, done); a deactivated/reset/logged-out-everywhere
// user's already-issued access token stayed valid for up to its own
// remaining 15-minute lifetime after any of those events. Now does one
// lightweight, indexed read (users.id is the primary key) on every
// authenticated request, comparing live status/session_version against
// what the token claims. A mismatch is denied immediately -- the real
// revocation-window SLA this fix provides is "the very next request after
// the bump," not "up to 15 minutes later."
//
// role/businessId/name still come from the JWT claims, unchanged -- only
// status and session_version are read fresh. This is a deliberate,
// narrower fix than re-deriving every claim from the DB on every request:
// session_version is the single mechanism that invalidates a stale token
// wholesale (including a stale role claim) once whatever triggered the
// bump also updates session_version, exactly as HNT2-AUTH-001 describes.
//
// Applies uniformly to every account, including super_admin -- this is an
// authentication-validity check (is this token still live), a completely
// separate concern from requireRole's own, already-locked "super_admin
// bypasses every ROLE check" rule, which is untouched here.
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    next(unauthorized());
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  try {
    const payload = verifyAccessToken(token);

    const user = await prisma.users.findUnique({
      where: { id: payload.sub },
      select: { status: true, session_version: true },
    });
    if (!user || user.status !== "active" || user.session_version !== payload.sessionVersion) {
      next(unauthorized("Session no longer valid, please log in again"));
      return;
    }

    req.auth = { userId: payload.sub, businessId: payload.businessId, role: payload.role, name: payload.name };
    next();
  } catch {
    next(unauthorized());
  }
}
