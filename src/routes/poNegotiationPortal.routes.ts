import { Router } from "express";
import { secureLinkAuth } from "../middleware/secureLinkAuth";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { supplierPortalLimiter } from "../middleware/rateLimit";
import {
  viewPurchaseOrder,
  createMessage,
  listMessages,
  markMessageRead,
  saveDraftProposal,
  submitProposal,
  rejectProposal,
  listProposals,
  uploadAttachment,
  getNegotiationSummary,
} from "../controllers/poNegotiationPortal.controller";

// PO Supplier Negotiation Core -- supplier portal. The one unauthenticated
// (no JWT/session) route tree in this repo, gated entirely by secure-link
// token validity + a per-IP rate limit -- no RBAC role applies.
const router = Router();

router.use(supplierPortalLimiter);
router.use("/po/:token", secureLinkAuth);

router.get("/po/:token", viewPurchaseOrder);
router.get("/po/:token/messages", listMessages);
router.post("/po/:token/messages", requireIdempotencyKey, createMessage);
router.post("/po/:token/messages/:messageId/read", requireIdempotencyKey, markMessageRead);

router.get("/po/:token/proposals", listProposals);
router.post("/po/:token/proposals/draft", requireIdempotencyKey, saveDraftProposal);
router.post("/po/:token/proposals/:proposalId/submit", requireIdempotencyKey, submitProposal);
router.post("/po/:token/proposals/:proposalId/reject", requireIdempotencyKey, rejectProposal);

router.post("/po/:token/attachments", requireIdempotencyKey, uploadAttachment);

router.get("/po/:token/negotiation", getNegotiationSummary);

export default router;
