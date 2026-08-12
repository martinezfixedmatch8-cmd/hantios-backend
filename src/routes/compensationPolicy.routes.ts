import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createCompensationPolicy,
  listCompensationPolicies,
  getCompensationPolicy,
  acknowledgeCompensationPolicy,
} from "../controllers/compensationPolicy.controller";

const router = Router();

router.use(authenticate);

// Module 12 Session C, Addendum G. Write (publish a new policy version) =
// owner/manager, matching Employee Compensation's own bar. View =
// owner/manager/accountant.
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant"] as const;

router.post("/", requireRole(...writeRoles), requireIdempotencyKey, createCompensationPolicy);
router.get("/", requireRole(...viewRoles), listCompensationPolicies);
router.get("/:id", requireRole(...viewRoles), getCompensationPolicy);
// Deliberately NO requireRole here -- acknowledgement is either owner/
// manager recording on an employee's behalf, or an employee acknowledging
// their OWN linked record, and RBAC role tells us nothing about which
// employee record (if any) a logged-in user actually is. The service layer
// enforces the real authorization check (self-or-elevated).
router.post("/:id/acknowledge", acknowledgeCompensationPolicy);

export default router;
