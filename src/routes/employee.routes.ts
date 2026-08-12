import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createEmployee,
  listEmployees,
  getEmployee,
  updateEmployee,
  archiveEmployee,
  restoreEmployee,
} from "../controllers/employee.controller";
import { createEmployeeCompensation, listEmployeeCompensation } from "../controllers/employeeCompensation.controller";

const router = Router();

router.use(authenticate);

// Module 12 Session A -- write = owner/manager (moves toward real money via
// downstream payroll), view = owner/manager/accountant, matching the
// spec's own RBAC table. Idempotency-Key on create/archive is an inferred
// addition (financial-adjacent record, matches Suppliers'/Customers' own
// precedent) -- PATCH/restore are version-guarded, safe without one.
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant"] as const;

router.post("/", requireRole(...writeRoles), requireIdempotencyKey, createEmployee);
router.get("/", requireRole(...viewRoles), listEmployees);
router.get("/:id", requireRole(...viewRoles), getEmployee);
router.patch("/:id", requireRole(...writeRoles), updateEmployee);
router.post("/:id/archive", requireRole(...writeRoles), requireIdempotencyKey, archiveEmployee);
router.post("/:id/restore", requireRole(...writeRoles), restoreEmployee);

router.post("/:id/compensation", requireRole(...writeRoles), createEmployeeCompensation);
router.get("/:id/compensation", requireRole(...viewRoles), listEmployeeCompensation);

export default router;
