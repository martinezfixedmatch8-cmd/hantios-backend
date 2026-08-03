import type { Request } from "express";
import { unauthorized } from "./errors";
import { prisma } from "./prisma";
import { normalizePhone } from "./phoneNormalization";

// Shared between the owner-side authenticated routes and the supplier
// portal's token-authenticated ones -- every po_negotiation_*.service.ts
// function takes this instead of two separate parameter shapes, so
// business logic (create a message, submit a proposal, ...) is written
// exactly once, per the spec's own "share the same underlying services --
// do not duplicate business logic" requirement.
export type NegotiationActor =
  | { party: "owner"; userId: string; businessId: string; userName: string; userRole: string }
  | { party: "supplier"; businessId: string; name: string; phone: string; department?: string; role?: string; ipAddress: string | null };

export function getOwnerNegotiationActor(req: Request): NegotiationActor {
  if (!req.auth) throw unauthorized();
  return { party: "owner", userId: req.auth.userId, businessId: req.auth.businessId, userName: req.auth.name, userRole: req.auth.role };
}

// audit_logs.user_id is a real, required FK to users -- a literal "supplier"
// string would violate it. Same problem the Debt Reminder Scheduler already
// solved in this codebase (a non-user trigger needing an FK-valid audit
// actor): reuse the PO's own created_by as the FK-satisfying user_id, with
// an honest user_name/user_role so the audit trail still says who actually
// triggered it, without any audit_logs schema change.
export function resolveAuditActor(actor: NegotiationActor, po: { created_by: string }): { userId: string; userName: string; userRole: string } {
  if (actor.party === "owner") {
    return { userId: actor.userId, userName: actor.userName, userRole: actor.userRole };
  }
  return { userId: po.created_by, userName: `Supplier: ${actor.name} (${actor.phone})`, userRole: "supplier" };
}

// Builds a supplier-side NegotiationActor from a portal request body --
// normalizes the phone via the existing libphonenumber-js helper (throws
// badRequest on an invalid number, same as every other write path that
// normalizes a phone in this repo). businessId comes from the already-
// resolved secure link (req.secureLink), never the request body.
export async function buildSupplierActor(
  req: Request,
  input: { senderName: string; senderPhone: string; department?: string; role?: string }
): Promise<NegotiationActor> {
  const businessId = req.secureLink!.purchaseOrder.business_id;
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
  const phone = normalizePhone(input.senderPhone, business.country);
  return {
    party: "supplier",
    businessId,
    name: input.senderName,
    phone: phone.normalized,
    department: input.department,
    role: input.role,
    ipAddress: req.ip ?? null,
  };
}
