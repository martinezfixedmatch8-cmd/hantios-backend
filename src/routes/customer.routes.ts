import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createCustomer,
  listCustomers,
  getCustomer,
  getCustomerTimeline,
  updateCustomer,
  archiveCustomer,
  restoreCustomer,
} from "../controllers/customer.controller";

const router = Router();

router.use(authenticate);

// Storekeeper/shareholder/custom: ZERO access anywhere (locked, matches the
// general rule every other module follows).
const viewRoles = ["owner", "manager", "cashier", "accountant"] as const;
const writeRoles = ["owner", "manager", "cashier"] as const;
// Restore's RBAC wasn't stated explicitly in the spec -- matching archive's
// bar (owner/manager) by symmetry with every other module's archive/restore
// pairing, flagged in CLAUDE.md as an inferred decision, not silently assumed.
const archiveRoles = ["owner", "manager"] as const;

router.post("/", requireRole(...writeRoles), requireIdempotencyKey, createCustomer);
router.get("/", requireRole(...viewRoles), listCustomers);
router.get("/:id", requireRole(...viewRoles), getCustomer);
router.get("/:id/timeline", requireRole(...viewRoles), getCustomerTimeline);
router.patch("/:id", requireRole(...writeRoles), updateCustomer);
router.post("/:id/archive", requireRole(...archiveRoles), requireIdempotencyKey, archiveCustomer);
router.post("/:id/restore", requireRole(...archiveRoles), restoreCustomer);

export default router;
