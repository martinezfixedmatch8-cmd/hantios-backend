import { prisma } from "./prisma";
import { badRequest } from "./errors";
import type { purchase_orders } from "@prisma/client";

// Workflow Guard (Enhancement #10): negotiation activity (secure-link
// generation, messages, proposals, attachments) is only allowed while a PO
// is actively negotiable. Two independent conditions, both checked:
//   - po.status === "sent" -- once CONFIRMED/CANCELLED/etc., negotiation is
//     over (see computeNegotiationStatus's own AGREED/REJECTED branches).
//   - zero goods_received_notes rows exist for this PO -- GRN receiving is
//     allowed against a "sent"-status PO in this repo's own Module 11
//     Session B design, so "GRN Started" is a real, separate gate, not
//     subsumed by status alone.
// "Shipment Started" (the enhancement's third trigger) has no corresponding
// concept in this codebase yet (Shipments are Session 3, unbuilt) --
// omitted for now, a follow-up hook for whenever that session lands.
export async function assertNegotiationOpen(po: Pick<purchase_orders, "id" | "status">): Promise<void> {
  if (po.status !== "sent") {
    throw badRequest(`Negotiation is only available while the purchase order is in SENT status (current status: ${po.status})`);
  }
  const grnCount = await prisma.goods_received_notes.count({ where: { purchase_order_id: po.id } });
  if (grnCount > 0) {
    throw badRequest("Negotiation is locked -- goods have already been received against this purchase order");
  }
}
