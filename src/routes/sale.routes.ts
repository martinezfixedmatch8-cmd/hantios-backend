import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { createSale, listSales, getSale } from "../controllers/sale.controller";

const router = Router();

router.use(authenticate);

// Create: owner, manager, cashier (cashier explicitly confirmed by the spec;
// storekeeper explicitly has no sales access at all, per CLAUDE.md's Auth
// Architecture section). List/get add accountant for reporting/reconciliation
// visibility, same reasoning Products used for its own read-role split.
const readRoles = ["owner", "manager", "cashier", "accountant"] as const;

router.post("/", requireRole("owner", "manager", "cashier"), requireIdempotencyKey, createSale);
router.get("/", requireRole(...readRoles), listSales);
router.get("/:id", requireRole(...readRoles), getSale);

export default router;
