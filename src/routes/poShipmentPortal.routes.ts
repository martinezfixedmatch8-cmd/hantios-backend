import { Router } from "express";
import { secureLinkAuth } from "../middleware/secureLinkAuth";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { supplierPortalLimiter } from "../middleware/rateLimit";
import {
  createShipment,
  listShipments,
  updateShipmentEta,
  uploadShipmentAttachment,
  createMilestone,
  listMilestones,
} from "../controllers/poShipmentPortal.controller";

// Module 11 Session 3 -- supplier-portal side of Shipments/Tracking/
// Delivery Milestones/ETA. Token-gated only, no RBAC role, same shape as
// the existing PO Negotiation portal router. No status-transition route
// here -- per the locked API surface, shipment status transitions stay
// owner-only (the supplier reports logistics facts; the owner's side
// confirms/tracks operational state), mirroring how Proposal accept is
// owner-only in PO Negotiation.
const router = Router();

router.use(supplierPortalLimiter);
router.use("/po/:token", secureLinkAuth);

router.get("/po/:token/shipments", listShipments);
router.post("/po/:token/shipments", requireIdempotencyKey, createShipment);
router.post("/po/:token/shipments/:shipmentId/eta", requireIdempotencyKey, updateShipmentEta);
router.post("/po/:token/shipments/:shipmentId/attachments", requireIdempotencyKey, uploadShipmentAttachment);

router.post("/po/:token/delivery-milestones", requireIdempotencyKey, createMilestone);
router.get("/po/:token/delivery-milestones", listMilestones);

export default router;
