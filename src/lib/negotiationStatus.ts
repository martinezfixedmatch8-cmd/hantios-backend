export type NegotiationStatus = "EXPIRED" | "AGREED" | "REJECTED" | "WAITING_SUPPLIER" | "WAITING_OWNER" | "OPEN";

interface StatusPo {
  status: string;
  negotiation_respond_by: Date | null;
}
interface StatusSecureLink {
  status: string;
}
interface StatusProposal {
  status: string;
  proposed_by: string;
}

// Pure, JS-only derivation -- mirrors decorateDebt/getDebt's shape, not
// listDebts' raw-SQL CASE (this session has no list/filter endpoint that
// needs to filter many POs by negotiation status at the DB layer, only a
// single-PO summary read, exactly getDebt's own shape). Never stored.
export function computeNegotiationStatus(
  po: StatusPo,
  latestSubmittedProposal: StatusProposal | null,
  secureLink: StatusSecureLink | null,
  now: Date
): NegotiationStatus {
  if (po.status === "cancelled") return "REJECTED";
  // Anything past `sent` that isn't cancelled (confirmed/partially_received/
  // received) means the PO's terms are locked in -- negotiation concluded
  // in agreement.
  if (po.status !== "sent") return "AGREED";
  if (po.negotiation_respond_by && po.negotiation_respond_by.getTime() < now.getTime()) return "EXPIRED";
  if (secureLink && (secureLink.status === "expired" || secureLink.status === "revoked")) return "EXPIRED";
  if (latestSubmittedProposal?.status === "pending") {
    return latestSubmittedProposal.proposed_by === "owner" ? "WAITING_SUPPLIER" : "WAITING_OWNER";
  }
  return "OPEN";
}
