import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { badRequest, conflict, notFound } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { paginate, resolveListQuery } from "../lib/pagination";
import { assertNegotiationOpen } from "../lib/poNegotiationGuards";
import { resolveAuditActor, type NegotiationActor } from "../lib/negotiationActor";
import { getStorageProvider } from "../storage/registry";
import { mimeTypeToAttachmentType } from "../validation/poNegotiationAttachment.schema";
import type { DraftProposalInput, RejectProposalInput, ListProposalsQuery } from "../validation/poNegotiationProposal.schema";

// Same Neon-latency reasoning as every other transactional service in this
// repo -- accept in particular does a counter-free but multi-row apply loop
// + agreement snapshot + audit + idempotency completion.
const PROPOSAL_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

const PROPOSAL_INCLUDE = { changes: true, attachments: true } as const;

export function draftProposalEndpoint(poId: string): string {
  return `POST /purchase-orders/${poId}/negotiation/proposals/draft`;
}
export function submitProposalEndpoint(poId: string, proposalId: string): string {
  return `POST /purchase-orders/${poId}/negotiation/proposals/${proposalId}/submit`;
}
export function acceptProposalEndpoint(poId: string, proposalId: string): string {
  return `POST /purchase-orders/${poId}/negotiation/proposals/${proposalId}/accept`;
}
export function rejectProposalEndpoint(poId: string, proposalId: string): string {
  return `POST /purchase-orders/${poId}/negotiation/proposals/${proposalId}/reject`;
}

// create-or-update the CALLER'S OWN in-progress draft for this PO.
// Interpretation, flagged explicitly (the spec's endpoint takes no
// proposalId, so there is no way for a caller to name which draft they
// mean): each PARTY (owner xor supplier) has at most one draft-status
// proposal per PO at a time -- the endpoint always targets
// `WHERE purchase_order_id, proposed_by=actor.party, status='draft'`,
// creating one if none exists yet. This is the only interpretation that
// fits a session-less supplier portal (no login means no way to
// distinguish "the same supplier continuing their draft" from "a new
// supplier individual" beyond the party itself).
export async function saveDraft(poId: string, input: DraftProposalInput, actor: NegotiationActor, idempotencyKey: string): Promise<unknown> {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  await assertNegotiationOpen(po);

  const existing = await prisma.po_negotiation_proposals.findFirst({
    where: { purchase_order_id: poId, business_id: actor.businessId, proposed_by: actor.party, status: "draft" },
  });

  if (existing && input.version === undefined) {
    throw badRequest("A draft already exists for you on this purchase order -- resend with its current version to update it");
  }
  if (!existing && input.version !== undefined) {
    throw badRequest("No draft exists yet -- omit version on the first save");
  }

  const proposerName = actor.party === "owner" ? actor.userName : actor.name;
  const proposerDepartment = actor.party === "supplier" ? (actor.department ?? null) : null;
  const proposerRole = actor.party === "supplier" ? (actor.role ?? null) : null;
  const ipAddress = actor.party === "supplier" ? actor.ipAddress : null;

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, draftProposalEndpoint(poId));
    let proposalId: string;
    if (existing) {
      const guarded = await tx.po_negotiation_proposals.updateMany({
        where: { id: existing.id, business_id: actor.businessId, status: "draft", version: input.version },
        data: { comment: input.comment ?? null, proposer_name: proposerName, proposer_department: proposerDepartment, proposer_role: proposerRole, ip_address: ipAddress, version: { increment: 1 } },
      });
      if (guarded.count === 0) throw conflict("Draft was modified concurrently, please retry with the latest version");
      proposalId = existing.id;
      // Full-replace semantics on the child change set, same pattern as
      // PO's own PATCH-while-DRAFT line-item replacement.
      await tx.po_negotiation_proposal_changes.deleteMany({ where: { proposal_id: proposalId } });
      // Enhancement #2 -- attachments are also full-replaced alongside
      // changes/comment on every draft save.
      await tx.po_negotiation_attachments.deleteMany({ where: { proposal_id: proposalId } });
    } else {
      const created = await tx.po_negotiation_proposals.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          purchase_order_id: poId,
          proposed_by: actor.party,
          proposer_name: proposerName,
          proposer_department: proposerDepartment,
          proposer_role: proposerRole,
          comment: input.comment ?? null,
          ip_address: ipAddress,
        },
      });
      proposalId = created.id;
    }

    await tx.po_negotiation_proposal_changes.createMany({
      data: input.changes.map((c) => ({
        id: generateId(),
        business_id: actor.businessId,
        proposal_id: proposalId,
        field_changed: c.fieldChanged,
        item_id: c.itemId ?? null,
        old_value: "", // snapshotted properly at submit time, once the draft is final -- see submitProposal
        new_value: c.newValue,
      })),
    });

    if (input.attachments && input.attachments.length > 0) {
      const registered = await Promise.all(
        input.attachments.map((a) =>
          getStorageProvider().registerUpload({
            businessId: actor.businessId,
            fileName: a.fileName,
            mimeType: a.mimeType,
            sizeBytes: a.fileSizeBytes,
            clientStorageKey: a.storageKey,
          })
        )
      );
      await tx.po_negotiation_attachments.createMany({
        data: input.attachments.map((a, i) => ({
          id: generateId(),
          business_id: actor.businessId,
          purchase_order_id: poId,
          proposal_id: proposalId,
          type: mimeTypeToAttachmentType(a.mimeType),
          file_name: a.fileName,
          file_size_bytes: a.fileSizeBytes,
          storage_key: registered[i].storageKey,
          uploaded_by: actor.party,
          uploaded_by_name: proposerName,
        })),
      });
    }

    const fresh = await tx.po_negotiation_proposals.findUniqueOrThrow({ where: { id: proposalId }, include: PROPOSAL_INCLUDE });
    const responseBody = JSON.parse(JSON.stringify({ data: fresh })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, draftProposalEndpoint(poId), 200, responseBody);
    return fresh;
  }, PROPOSAL_TRANSACTION_OPTIONS);

  return result;
}

// draft -> pending. Snapshots old_value for every change at THIS moment
// (not at draft-save time, since a long-lived draft's underlying item
// values could have drifted -- e.g. another accepted proposal changed the
// same item while this draft sat unsubmitted). Assigns revision_number
// (sequential per PO, only now, never on draft save). Supersedes any
// existing PENDING proposal from the SAME side (never a draft -- drafts
// are simply abandoned, per the locked "not cleaned up automatically"
// rule). Publishes PurchaseOrderNegotiationProposalSubmitted.
export async function submitProposal(
  poId: string,
  proposalId: string,
  version: number,
  actor: NegotiationActor,
  idempotencyKey: string
) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  await assertNegotiationOpen(po);

  const proposal = await getOwned(prisma.po_negotiation_proposals.findUnique({ where: { id: proposalId }, include: PROPOSAL_INCLUDE }), actor.businessId, "Proposal");
  if (proposal.purchase_order_id !== poId) throw notFound("Proposal not found");
  if (proposal.proposed_by !== actor.party) throw notFound("Proposal not found");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, submitProposalEndpoint(poId, proposalId));

    const guarded = await tx.po_negotiation_proposals.updateMany({
      where: { id: proposalId, business_id: actor.businessId, status: "draft", version },
      data: { status: "pending" },
    });
    if (guarded.count === 0) throw conflict("Draft was modified concurrently, or is no longer a draft -- please retry with the latest version");

    // Snapshot old_value per change, right now, from the CURRENT live state.
    for (const change of proposal.changes) {
      let oldValue = "";
      if (change.item_id) {
        const item = await tx.purchase_order_items.findUnique({ where: { id: change.item_id } });
        if (item) {
          if (change.field_changed === "quantity") oldValue = item.quantity_ordered.toString();
          else if (change.field_changed === "unit_price") oldValue = item.unit_cost_snapshot.toString();
          else if (change.field_changed === "product_substitution") oldValue = item.product_id;
          else if (change.field_changed === "product_removed") oldValue = item.product_name_snapshot;
        }
      }
      await tx.po_negotiation_proposal_changes.update({ where: { id: change.id }, data: { old_value: oldValue } });
    }

    // Assign revision_number now (sequential per PO, count of already-
    // submitted proposals + 1 -- never counts drafts).
    const submittedCount = await tx.po_negotiation_proposals.count({
      where: { purchase_order_id: poId, business_id: actor.businessId, submitted_at: { not: null } },
    });
    const revisionNumber = submittedCount + 1;

    await tx.po_negotiation_proposals.update({
      where: { id: proposalId },
      data: { submitted_at: new Date(), revision_number: revisionNumber },
    });

    // Supersede any existing PENDING proposal from the same side (never a
    // draft) -- only on submission, matching the locked rule literally.
    await tx.po_negotiation_proposals.updateMany({
      where: { purchase_order_id: poId, business_id: actor.businessId, proposed_by: actor.party, status: "pending", id: { not: proposalId } },
      data: { status: "superseded" },
    });

    const auditActor = resolveAuditActor(actor, po);
    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: auditActor.userId,
      userName: auditActor.userName,
      userRole: auditActor.userRole,
      action: "purchase_order.negotiation_proposal_submitted",
      entityType: "po_negotiation_proposal",
      entityId: proposalId,
      reason: proposal.comment ?? `Proposal (revision ${revisionNumber}) submitted on PO ${po.po_number}`,
    });

    const fresh = await tx.po_negotiation_proposals.findUniqueOrThrow({ where: { id: proposalId }, include: PROPOSAL_INCLUDE });
    const responseBody = JSON.parse(JSON.stringify({ data: fresh })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, submitProposalEndpoint(poId, proposalId), 200, responseBody);
    return { fresh, revisionNumber };
  }, PROPOSAL_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderNegotiationProposalSubmitted", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    proposalId,
    revisionNumber: result.revisionNumber,
  });

  return result.fresh;
}

async function applyChange(
  tx: Prisma.TransactionClient,
  businessId: string,
  poId: string,
  change: { field_changed: string; item_id: string | null; new_value: string }
): Promise<void> {
  switch (change.field_changed) {
    case "quantity": {
      const item = await getOwned(tx.purchase_order_items.findUnique({ where: { id: change.item_id! } }), businessId, "Purchase order item");
      const newQty = new Prisma.Decimal(change.new_value);
      const newLineTotal = newQty.times(item.unit_cost_snapshot).toDecimalPlaces(2);
      await tx.purchase_order_items.update({ where: { id: item.id }, data: { quantity_ordered: newQty, line_total: newLineTotal } });
      break;
    }
    case "unit_price": {
      const item = await getOwned(tx.purchase_order_items.findUnique({ where: { id: change.item_id! } }), businessId, "Purchase order item");
      const newCost = new Prisma.Decimal(change.new_value);
      const newLineTotal = item.quantity_ordered.times(newCost).toDecimalPlaces(2);
      await tx.purchase_order_items.update({ where: { id: item.id }, data: { unit_cost_snapshot: newCost, line_total: newLineTotal } });
      break;
    }
    case "product_substitution": {
      const item = await getOwned(tx.purchase_order_items.findUnique({ where: { id: change.item_id! } }), businessId, "Purchase order item");
      const newProduct = await getOwned(tx.products.findUnique({ where: { id: change.new_value } }), businessId, "Product");
      if (newProduct.status !== "active") throw badRequest(`Cannot substitute in archived product "${newProduct.name}"`);
      const duplicate = await tx.purchase_order_items.findFirst({ where: { purchase_order_id: poId, product_id: newProduct.id, id: { not: item.id } } });
      if (duplicate) throw badRequest(`Product "${newProduct.name}" already exists as a separate line item on this purchase order`);
      // quantity_ordered/unit_cost_snapshot/line_total carry forward
      // unchanged -- a coordinated price/quantity change is a separate
      // change entry in the same proposal, applied independently.
      await tx.purchase_order_items.update({
        where: { id: item.id },
        data: { product_id: newProduct.id, product_name_snapshot: newProduct.name, sku_snapshot: newProduct.sku },
      });
      break;
    }
    case "product_added": {
      const parsed = JSON.parse(change.new_value) as { productId: string; quantity: number; unitCost: number };
      const product = await getOwned(tx.products.findUnique({ where: { id: parsed.productId } }), businessId, "Product");
      if (product.status !== "active") throw badRequest(`Cannot add archived product "${product.name}"`);
      const duplicate = await tx.purchase_order_items.findFirst({ where: { purchase_order_id: poId, product_id: product.id } });
      if (duplicate) throw badRequest(`Product "${product.name}" already exists as a line item on this purchase order`);
      const qty = new Prisma.Decimal(parsed.quantity);
      const unitCost = new Prisma.Decimal(parsed.unitCost);
      await tx.purchase_order_items.create({
        data: {
          id: generateId(),
          business_id: businessId,
          purchase_order_id: poId,
          product_id: product.id,
          product_name_snapshot: product.name,
          sku_snapshot: product.sku,
          quantity_ordered: qty,
          unit_cost_snapshot: unitCost,
          line_total: qty.times(unitCost).toDecimalPlaces(2),
        },
      });
      break;
    }
    case "product_removed": {
      await getOwned(tx.purchase_order_items.findUnique({ where: { id: change.item_id! } }), businessId, "Purchase order item");
      await tx.purchase_order_items.delete({ where: { id: change.item_id! } });
      break;
    }
    case "delivery_date":
    case "shipping_method":
      // No live purchase_orders/purchase_order_items column corresponds to
      // either of these (this schema's Module 11 Session A/B design never
      // needed one) -- captured only in the Agreement Snapshot's own
      // dedicated shipping_method/delivery_date columns, written below in
      // acceptProposal. Nothing to apply here.
      break;
    default:
      break;
  }
}

// The core state transition. pending -> accepted, EVERY child change
// applied atomically (Enhancement #1's "Most Important Architectural
// Rule"), Agreement Snapshot written, negotiation_round incremented.
// Owner-only this session (supplier-side acceptance is not enabled for v1,
// per the locked default).
export async function acceptProposal(poId: string, proposalId: string, actor: NegotiationActor, idempotencyKey: string) {
  if (actor.party !== "owner") throw badRequest("Only the business owner/manager can accept a proposal this session");

  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  await assertNegotiationOpen(po);

  const proposal = await getOwned(prisma.po_negotiation_proposals.findUnique({ where: { id: proposalId }, include: PROPOSAL_INCLUDE }), actor.businessId, "Proposal");
  if (proposal.purchase_order_id !== poId) throw notFound("Proposal not found");
  if (proposal.status === "draft") throw badRequest("A draft proposal must be submitted before it can be accepted");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, acceptProposalEndpoint(poId, proposalId));

    // Guard: proposal must still be pending -- atomic, Final-State-
    // Protection shape identical to every other status transition in this
    // repo. count === 0 means it was already resolved (or never pending),
    // by another request -- 409, never a silent double-apply.
    const guarded = await tx.po_negotiation_proposals.updateMany({
      where: { id: proposalId, business_id: actor.businessId, status: "pending" },
      data: { status: "accepted", resolved_at: new Date(), resolved_by: actor.userId },
    });
    if (guarded.count === 0) {
      throw conflict("Proposal is no longer pending -- it may have already been accepted, rejected, or superseded");
    }

    let shippingMethod: string | null = null;
    let deliveryDate: Date | null = null;
    for (const change of proposal.changes) {
      await applyChange(tx, actor.businessId, poId, change);
      if (change.field_changed === "shipping_method") shippingMethod = change.new_value;
      if (change.field_changed === "delivery_date") deliveryDate = new Date(change.new_value);
    }

    // Recompute total_expected_value from the CURRENT items post-apply --
    // same derived-cache-recompute-at-the-one-write-point pattern PO's own
    // PATCH-while-draft already uses.
    const items = await tx.purchase_order_items.findMany({ where: { purchase_order_id: poId } });
    const totalExpectedValue = items.reduce((sum, item) => sum.plus(item.line_total), new Prisma.Decimal(0));

    const updatedPo = await tx.purchase_orders.update({
      where: { id: poId },
      data: { total_expected_value: totalExpectedValue, negotiation_round: { increment: 1 }, version: { increment: 1 } },
    });

    const snapshot = await tx.po_negotiation_agreement_snapshots.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        purchase_order_id: poId,
        proposal_id: proposalId,
        negotiation_round: updatedPo.negotiation_round,
        items_snapshot: JSON.parse(
          JSON.stringify(
            items.map((i) => ({ productId: i.product_id, productNameSnapshot: i.product_name_snapshot, quantity: i.quantity_ordered, unitCost: i.unit_cost_snapshot, lineTotal: i.line_total }))
          )
        ) as Prisma.InputJsonValue,
        shipping_method: shippingMethod,
        delivery_date: deliveryDate,
        total_expected_value: totalExpectedValue,
        accepted_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "purchase_order.negotiation_accepted",
      entityType: "po_negotiation_proposal",
      entityId: proposalId,
      reason: proposal.comment ?? `Proposal (revision ${proposal.revision_number ?? "?"}) accepted on PO ${po.po_number}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: { proposal: { ...proposal, status: "accepted" }, purchaseOrder: updatedPo, agreementSnapshot: snapshot } })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, acceptProposalEndpoint(poId, proposalId), 200, responseBody);

    return { purchaseOrder: updatedPo, snapshot };
  }, PROPOSAL_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderNegotiationAccepted", {
    businessId: actor.businessId,
    purchaseOrderId: poId,
    proposalId,
    negotiationRound: result.purchaseOrder.negotiation_round,
  });

  return {
    proposal: await prisma.po_negotiation_proposals.findUniqueOrThrow({ where: { id: proposalId }, include: PROPOSAL_INCLUDE }),
    purchaseOrder: result.purchaseOrder,
    agreementSnapshot: result.snapshot,
  };
}

// Rejecting never touches purchase_order_items -- only accept does.
export async function rejectProposal(poId: string, proposalId: string, input: RejectProposalInput, actor: NegotiationActor, idempotencyKey: string) {
  const po = await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), actor.businessId, "Purchase order");
  const proposal = await getOwned(prisma.po_negotiation_proposals.findUnique({ where: { id: proposalId } }), actor.businessId, "Proposal");
  if (proposal.purchase_order_id !== poId) throw notFound("Proposal not found");
  if (proposal.status === "draft") throw badRequest("A draft proposal must be submitted before it can be rejected");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, rejectProposalEndpoint(poId, proposalId));

    const auditActor = resolveAuditActor(actor, po);

    const guarded = await tx.po_negotiation_proposals.updateMany({
      where: { id: proposalId, business_id: actor.businessId, status: "pending" },
      data: { status: "rejected", resolved_at: new Date(), resolved_by: auditActor.userId },
    });
    if (guarded.count === 0) {
      throw conflict("Proposal is no longer pending -- it may have already been accepted, rejected, or superseded");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: auditActor.userId,
      userName: auditActor.userName,
      userRole: auditActor.userRole,
      action: "purchase_order.negotiation_rejected",
      entityType: "po_negotiation_proposal",
      entityId: proposalId,
      reason: input.reason,
    });

    const fresh = await tx.po_negotiation_proposals.findUniqueOrThrow({ where: { id: proposalId }, include: PROPOSAL_INCLUDE });
    const responseBody = JSON.parse(JSON.stringify({ data: fresh })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, rejectProposalEndpoint(poId, proposalId), 200, responseBody);
    return fresh;
  }, PROPOSAL_TRANSACTION_OPTIONS);

  domainEvents.publish("PurchaseOrderNegotiationRejected", { businessId: actor.businessId, purchaseOrderId: poId, proposalId });

  return result;
}

// Excludes the OTHER party's drafts, always -- the caller's OWN draft (if
// any) still appears, so they can find it to keep editing.
export async function listProposals(poId: string, query: ListProposalsQuery, actorParty: "owner" | "supplier", businessId: string) {
  await getOwned(prisma.purchase_orders.findUnique({ where: { id: poId } }), businessId, "Purchase order");

  const otherParty: "owner" | "supplier" = actorParty === "owner" ? "supplier" : "owner";
  const resolved = resolveListQuery(query, { sortableFields: ["created_at"] as const, defaultSort: "created_at" as const });

  const where = {
    business_id: businessId,
    purchase_order_id: poId,
    NOT: { status: "draft" as const, proposed_by: otherParty },
  };
  const [rows, total] = await Promise.all([
    prisma.po_negotiation_proposals.findMany({ where, include: PROPOSAL_INCLUDE, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.po_negotiation_proposals.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}
