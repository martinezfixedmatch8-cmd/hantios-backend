import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { createSale, listSales, getSale, voidSale, refundSale, setSaleAttribution, listSaleRefunds } from "../controllers/sale.controller";

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
// Batch 5 (HNT2-SALE-001) -- dedicated paginated refund-history subresource,
// same read bar as the parent sale.
router.get("/:id/refunds", requireRole(...readRoles), listSaleRefunds);

// Void: same-day self-service correction. Manager deliberately excluded --
// confirmed decision, does not bypass the way it does everywhere else in this
// module. super_admin still bypasses via requireRole itself. The "only the
// cashier who created it" rule is enforced in the service (role alone can't
// express per-resource ownership).
router.post("/:id/void", requireRole("owner", "cashier"), requireIdempotencyKey, voidSale);
// Refund: post-day-close, financial-only. No cashier at all.
router.post("/:id/refund", requireRole("owner", "manager"), requireIdempotencyKey, refundSale);
// Module 12 Session C -- attribution CORRECTION, owner/manager only
// (confirmed -- no cashier exception, unlike Void). Setting attribution
// live at creation is a separate path (POST /sales' own optional field),
// already covered by that endpoint's existing RBAC.
router.post("/:id/attribution", requireRole("owner", "manager"), requireIdempotencyKey, setSaleAttribution);

export default router;
