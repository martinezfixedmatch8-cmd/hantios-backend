import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { generateSecureToken, hashToken } from "../lib/tokens";
import { assertNegotiationOpen } from "../lib/poNegotiationGuards";
import { env } from "../lib/config";
import { getNotificationProvider } from "../notifications/registry";
import { renderEmailTemplate } from "../notifications/EmailTemplateRenderer";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

// Same Neon-latency reasoning as every other transactional service in this
// repo.
const SECURE_LINK_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

// Fixed 30 days for v1, not business-configurable -- locked decision,
// confirmed both in the user's own spec and independently in the source
// document's own "Open Question" resolution.
const LINK_EXPIRY_DAYS = 30;

export function regenerateSecureLinkEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/secure-link/regenerate`;
}
export function revokeSecureLinkEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/secure-link/revoke`;
}

function buildSecureLinkUrl(rawToken: string): string {
  return `${env.APP_BASE_URL}/po/${rawToken}`;
}

// There is no separate "generate" endpoint -- regenerate IS create-or-
// replace: one PO = one active link at a time, so the first call for a PO
// creates it, and every subsequent call atomically revokes whatever was
// active and creates a fresh one. The raw token is returned here, in this
// response body, EXACTLY ONCE -- only its SHA-256 hash is ever persisted,
// so this is the only moment it can ever be retrieved. Never logged to
// console, never written to audit_logs/beforeState/afterState.
export async function regenerateSecureLink(poId: string, actor: Actor, idempotencyKey: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  await assertNegotiationOpen(po);

  const rawToken = generateSecureToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const link = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, regenerateSecureLinkEndpoint(poId));

    // One PO = one active link at a time -- revoke any prior active link
    // before creating the new one, in the same transaction.
    await tx.po_secure_links.updateMany({
      where: { purchase_order_id: poId, business_id: actor.businessId, status: "active" },
      data: { status: "revoked", revoked_at: new Date(), revoked_by: actor.userId },
    });

    const created = await tx.po_secure_links.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.secure_link_generated",
      entityType: "po_secure_link",
      entityId: created.id,
      reason: `Secure link generated for PO ${po.po_number}`,
    });

    const responseBody = JSON.parse(
      JSON.stringify({ data: { ...created, url: buildSecureLinkUrl(rawToken) } })
    ) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, regenerateSecureLinkEndpoint(poId), 201, responseBody);

    return created;
  }, SECURE_LINK_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderSecureLinkGenerated", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    secureLinkId: link.id,
  });

  const url = buildSecureLinkUrl(rawToken);
  // Module 33 Session 4A -- the first real email this call site ever sends
  // (Phase 0 confirmed regenerateSecureLink previously only returned the
  // URL in the response body, for the owner to relay manually). Sent
  // fire-and-forget after the transaction has committed, same "DB writes in
  // the transaction, I/O after" pattern already established by
  // emailVerification.service.ts. Uses the PO's own supplier_email_snapshot
  // (already fetched above, zero extra query) rather than a live
  // suppliers.email lookup -- consistent with this module's own "policy
  // snapshot" principle (supplier_name_snapshot etc.): a later edit to the
  // live Supplier record must never retroactively change which address a
  // historical negotiation link goes to. Fail-soft when no email is on file
  // -- a supplier having no email is a real, unremarkable state (phone-only
  // suppliers exist), not an error; the link is still generated and
  // returned in the response either way.
  if (po.supplier_email_snapshot) {
    const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
    const { subject, body } = renderEmailTemplate("po_negotiation_secure_link", {
      businessName: business.name,
      poNumber: po.po_number,
      secureLinkUrl: url,
    });
    await getNotificationProvider().send({
      category: "TRANSACTIONAL",
      channel: "email",
      to: po.supplier_email_snapshot,
      businessId: actor.businessId,
      senderProfile: "NOTIFICATIONS",
      subject,
      body,
    });
  } else {
    console.warn(`[po-negotiation] no supplier email on file for PO ${po.po_number} -- secure link was generated but not emailed`);
  }

  return { ...link, url };
}

export async function revokeSecureLink(poId: string, actor: Actor, idempotencyKey: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, revokeSecureLinkEndpoint(poId));

    const guarded = await tx.po_secure_links.updateMany({
      where: { purchase_order_id: poId, business_id: actor.businessId, status: "active" },
      data: { status: "revoked", revoked_at: new Date(), revoked_by: actor.userId },
    });
    if (guarded.count === 0) {
      throw badRequest("No active secure link exists for this purchase order");
    }

    const link = await tx.po_secure_links.findFirstOrThrow({
      where: { purchase_order_id: poId, business_id: actor.businessId },
      orderBy: { created_at: "desc" },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.secure_link_revoked",
      entityType: "po_secure_link",
      entityId: link.id,
      reason: `Secure link revoked`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: link })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, revokeSecureLinkEndpoint(poId), 200, responseBody);
    return link;
  }, SECURE_LINK_TRANSACTION_OPTIONS);

  return result;
}

// Auto-expire on terminal PO status -- called from the same transaction as
// any PO status transition that reaches a terminal state (confirmed/
// cancelled), NOT a scheduler. Kept here as a small, reusable helper rather
// than duplicated inline at each PO status-transition call site.
export async function expireSecureLinksForTerminalPo(tx: import("@prisma/client").Prisma.TransactionClient, poId: string): Promise<void> {
  await tx.po_secure_links.updateMany({
    where: { purchase_order_id: poId, status: "active" },
    data: { status: "expired" },
  });
}

// Called on every GET view through the portal (never on state-changing
// requests). Returns whether this was the FIRST view ever (last_viewed_at
// was null beforehand) -- callers use this to decide whether to publish
// PurchaseOrderViewedBySupplier (debounced, first-view only, mirrors
// StockLow's own debounce shape). GET (view) has no per-view limit beyond
// the shared supplierPortalLimiter -- every view still increments
// view_count/last_viewed_at, but only the FIRST one fires the event.
export async function recordSupplierView(linkId: string): Promise<{ isFirstView: boolean }> {
  const existing = await prisma.po_secure_links.findUniqueOrThrow({ where: { id: linkId } });
  const isFirstView = existing.last_viewed_at === null;
  await prisma.po_secure_links.update({
    where: { id: linkId },
    data: { last_viewed_at: new Date(), view_count: { increment: 1 } },
  });
  return { isFirstView };
}
