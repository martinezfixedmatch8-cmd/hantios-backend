import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createPurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  updatePurchaseOrder,
  sendPurchaseOrder,
  confirmPurchaseOrder,
  cancelPurchaseOrder,
} from "../controllers/purchaseOrder.controller";
import { createGoodsReceivedNote } from "../controllers/goodsReceivedNote.controller";
import { recordPurchaseOrderPayment } from "../controllers/purchaseOrderPayment.controller";

const router = Router();

router.use(authenticate);

// RBAC per the locked spec: create/send/confirm/cancel = owner/manager.
// Storekeeper is read-only. View/list = owner/manager/accountant/storekeeper.
// Cashier/shareholder/custom: no access anywhere. PATCH (update) wasn't
// explicitly named -- inferred as the same bar as create, matching every
// other module's "create and update share a tier" convention.
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant", "storekeeper"] as const;

// Module 11 Session B -- GRN receiving is physical stock handling, mirroring
// Products' stock-adjustment RBAC bar (owner/manager/storekeeper), not the
// financial write-roles bar the rest of this router uses.
const grnRoles = ["owner", "manager", "storekeeper"] as const;

router.post("/", requireRole(...writeRoles), requireIdempotencyKey, createPurchaseOrder);
router.get("/", requireRole(...viewRoles), listPurchaseOrders);
router.get("/:id", requireRole(...viewRoles), getPurchaseOrder);
router.patch("/:id", requireRole(...writeRoles), updatePurchaseOrder);
router.post("/:id/send", requireRole(...writeRoles), requireIdempotencyKey, sendPurchaseOrder);
router.post("/:id/confirm", requireRole(...writeRoles), requireIdempotencyKey, confirmPurchaseOrder);
router.post("/:id/cancel", requireRole(...writeRoles), requireIdempotencyKey, cancelPurchaseOrder);
router.post("/:id/goods-received-notes", requireRole(...grnRoles), requireIdempotencyKey, createGoodsReceivedNote);
// Financial, storekeeper excluded -- mirrors Refund/write-off's elevated
// bar, not GRN's stock-handling bar.
router.post("/:id/payments", requireRole(...writeRoles), requireIdempotencyKey, recordPurchaseOrderPayment);

export default router;
