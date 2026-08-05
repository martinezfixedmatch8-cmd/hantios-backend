import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createShipment,
  listShipments,
  getShipment,
  updateShipmentStatus,
  updateShipment,
  updateShipmentEta,
  getRemainingQuantities,
} from "../controllers/poShipment.controller";
import { createMilestone, listMilestones } from "../controllers/poDeliveryMilestone.controller";
import { uploadShipmentAttachment, listShipmentAttachments } from "../controllers/poShipmentAttachment.controller";

// Module 11 Session 3 -- Shipments/Tracking/Delivery Milestones/ETA. Its
// own route file, mounted at the same /purchase-orders prefix as
// purchaseOrder.routes.ts/poNegotiation.routes.ts, matching the established
// "a large enough sub-feature gets its own route file" precedent PO
// Negotiation set in Session 1.
const router = Router();

router.use(authenticate);

// Locked RBAC table: Create/update shipments + ETA + attachments +
// milestones = Owner/Manager. View = Owner/Manager/Accountant/Storekeeper
// (storekeeper needs inbound-logistics visibility for warehouse planning --
// a judgment call flagged for review, not originally locked in the spec).
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant", "storekeeper"] as const;

router.post("/:id/shipments", requireRole(...writeRoles), requireIdempotencyKey, createShipment);
router.get("/:id/shipments", requireRole(...viewRoles), listShipments);
router.get("/:id/shipments/:shipmentId", requireRole(...viewRoles), getShipment);
router.patch("/:id/shipments/:shipmentId/status", requireRole(...writeRoles), requireIdempotencyKey, updateShipmentStatus);
// General logistics-detail edit endpoint (carrier/tracking/costs/priority
// only) -- added on second review, owner-side only, no supplier-portal
// equivalent (a deliberate default, not originally specified either way).
router.patch("/:id/shipments/:shipmentId", requireRole(...writeRoles), requireIdempotencyKey, updateShipment);
router.post("/:id/shipments/:shipmentId/eta", requireRole(...writeRoles), requireIdempotencyKey, updateShipmentEta);
router.get("/:id/shipments/:shipmentId/remaining-quantities", requireRole(...viewRoles), getRemainingQuantities);
router.post("/:id/shipments/:shipmentId/attachments", requireRole(...writeRoles), requireIdempotencyKey, uploadShipmentAttachment);
router.get("/:id/shipments/:shipmentId/attachments", requireRole(...viewRoles), listShipmentAttachments);

router.post("/:id/delivery-milestones", requireRole(...writeRoles), requireIdempotencyKey, createMilestone);
router.get("/:id/delivery-milestones", requireRole(...viewRoles), listMilestones);

export default router;
