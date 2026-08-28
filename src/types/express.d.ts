import type { UserRole, po_secure_links, purchase_orders } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      // Batch 8 Session B (HNT-OBS-001) -- set by requestId.ts, the very
      // first middleware in the chain. Always present by the time any later
      // middleware/route/error handler runs; optional only because the type
      // itself can't express "always set after this one middleware."
      requestId?: string;
      auth?: {
        userId: string;
        businessId: string;
        role: UserRole;
        name: string;
      };
      idempotencyKey?: string;
      // Set by secureLinkAuth for the supplier portal -- the one
      // unauthenticated (no JWT) route tree in this repo. Presence of this
      // property is what a supplier-portal controller checks instead of
      // req.auth.
      secureLink?: {
        link: po_secure_links;
        purchaseOrder: purchase_orders;
      };
    }
  }
}

export {};
