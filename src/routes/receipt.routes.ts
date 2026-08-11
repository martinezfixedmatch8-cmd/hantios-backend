import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { listReceipts, getReceipt, listDeliveryAttempts, requestReceiptDelivery } from "../controllers/receipt.controller";

const router = Router();

router.use(authenticate);

// Module 06 (Receipt System) -- RBAC not explicitly locked by the spec
// beyond "applicable RBAC," inferred by analogy to the closest existing
// precedent per receipt type's own trigger module (Sale's own readRoles
// for view; storekeeper added for view since receipts also cover
// Warehouse Stock Out / Supplier Goods Received, which Sale's own bar
// doesn't need to consider). Flagged as inferred, not silently assumed.
const viewRoles = ["owner", "manager", "cashier", "accountant", "storekeeper"] as const;
const deliverRoles = ["owner", "manager", "cashier", "storekeeper"] as const;

router.get("/", requireRole(...viewRoles), listReceipts);
router.get("/:id", requireRole(...viewRoles), getReceipt);
router.get("/:id/delivery-attempts", requireRole(...viewRoles), listDeliveryAttempts);
router.post("/:id/deliver", requireRole(...deliverRoles), requireIdempotencyKey, requestReceiptDelivery);

export default router;
