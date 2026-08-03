import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { hashToken } from "../lib/tokens";
import { notFound, gone } from "../lib/errors";

// The one unauthenticated (no JWT) route tree in this repo -- resolves the
// :token URL param by re-hashing it with the same hashToken already used
// for session refresh tokens (never store/compare the raw token), then
// validates the link is still usable. Applies identically to GET and
// state-changing routes: "GET is allowed unlimited times while active" (the
// locked spec's own wording) means no extra per-view limit beyond the
// shared supplierPortalLimiter, not that GET tolerates an inactive link --
// both directions 410 the same way once status/expiry fail. view_count/
// last_viewed_at are NOT touched here -- that increment belongs to the
// specific "view the PO" service function (the actual view action), not
// this generic auth gate, since not every request through this middleware
// represents a view (e.g. POST /messages does not).
export async function secureLinkAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.params.token;
    if (!token || typeof token !== "string") {
      next(notFound("Link not found"));
      return;
    }

    const tokenHash = hashToken(token);
    const link = await prisma.po_secure_links.findUnique({
      where: { token_hash: tokenHash },
      include: { purchase_orders: true },
    });

    if (!link) {
      next(notFound("Link not found"));
      return;
    }
    if (link.status !== "active" || link.expires_at <= new Date()) {
      next(gone("This link is no longer active"));
      return;
    }

    req.secureLink = { link, purchaseOrder: link.purchase_orders };
    next();
  } catch (err) {
    next(err);
  }
}
