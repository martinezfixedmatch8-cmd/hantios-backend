import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { regenerateSecureLink, revokeSecureLink } from "../controllers/poSecureLink.controller";
import { createMessage, listMessages, markMessageRead } from "../controllers/poNegotiationMessage.controller";
import {
  saveDraft,
  submitProposal,
  acceptProposal,
  rejectProposal,
  listProposals,
} from "../controllers/poNegotiationProposal.controller";
import { uploadAttachment } from "../controllers/poNegotiationAttachment.controller";
import { createInternalNote, listInternalNotes } from "../controllers/poNegotiationInternalNote.controller";
import { getNegotiationSummary, setDeadline } from "../controllers/poNegotiationSummary.controller";

// PO Supplier Negotiation Core -- owner side. Mounted at the same
// /purchase-orders prefix as the existing purchaseOrder.routes.ts (this
// module is large enough to warrant its own file, unlike GRN/PO-Payments
// which were folded directly into that one).
const router = Router();

router.use(authenticate);

// RBAC per the locked spec: view = owner/manager/accountant (read-only);
// write (message/proposal/attachment/accept/reject/deadline/secure-link) =
// owner/manager. Storekeeper/cashier/shareholder/custom: no access,
// consistent with Module 11's own existing bar.
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant"] as const;

router.post("/:id/secure-link/regenerate", requireRole(...writeRoles), requireIdempotencyKey, regenerateSecureLink);
router.post("/:id/secure-link/revoke", requireRole(...writeRoles), requireIdempotencyKey, revokeSecureLink);

router.get("/:id/negotiation/messages", requireRole(...viewRoles), listMessages);
router.post("/:id/negotiation/messages", requireRole(...writeRoles), requireIdempotencyKey, createMessage);
router.post("/:id/negotiation/messages/:messageId/read", requireRole(...writeRoles), requireIdempotencyKey, markMessageRead);

router.get("/:id/negotiation/proposals", requireRole(...viewRoles), listProposals);
router.post("/:id/negotiation/proposals/draft", requireRole(...writeRoles), requireIdempotencyKey, saveDraft);
router.post("/:id/negotiation/proposals/:proposalId/submit", requireRole(...writeRoles), requireIdempotencyKey, submitProposal);
router.post("/:id/negotiation/proposals/:proposalId/accept", requireRole(...writeRoles), requireIdempotencyKey, acceptProposal);
router.post("/:id/negotiation/proposals/:proposalId/reject", requireRole(...writeRoles), requireIdempotencyKey, rejectProposal);

router.post("/:id/negotiation/attachments", requireRole(...writeRoles), requireIdempotencyKey, uploadAttachment);

// Enhancement #8 -- Owner/Manager visibility ONLY, stricter than the
// general viewRoles bar above (which includes accountant) -- these are
// confidential negotiation notes, never shown to the supplier and, per the
// enhancement's own explicit "Owner/Manager-only" wording, not shown to
// accountant either.
router.post("/:id/negotiation/internal-notes", requireRole(...writeRoles), requireIdempotencyKey, createInternalNote);
router.get("/:id/negotiation/internal-notes", requireRole(...writeRoles), listInternalNotes);

router.get("/:id/negotiation", requireRole(...viewRoles), getNegotiationSummary);
router.post("/:id/negotiation/deadline", requireRole(...writeRoles), requireIdempotencyKey, setDeadline);

export default router;
