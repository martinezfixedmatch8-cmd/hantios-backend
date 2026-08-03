import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { stockIn, stockOut } from "../controllers/warehouseMovement.controller";

const router = Router();

router.use(authenticate);

// Mirrors Products' stock-adjustment RBAC bar exactly -- same class of
// action (physical stock handling), not a financial one. Cashier/
// accountant/shareholder/custom: no access, matching every other module's
// general rule.
const writeRoles = ["owner", "manager", "storekeeper"] as const;

router.post("/stock-in", requireRole(...writeRoles), requireIdempotencyKey, stockIn);
router.post("/stock-out", requireRole(...writeRoles), requireIdempotencyKey, stockOut);

export default router;
