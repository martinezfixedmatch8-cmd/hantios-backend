import type { UserRole, po_secure_links, purchase_orders } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
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
