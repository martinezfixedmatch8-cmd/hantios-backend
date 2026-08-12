import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { createDepartment, listDepartments } from "../controllers/department.controller";

const router = Router();

router.use(authenticate);

// Module 12 Session A -- RBAC confirmed: write = owner/manager, view adds
// accountant (matches the spec's own "Accountant: Finance only -- P&L,
// cash flow, payroll, debt reports"). No Idempotency-Key -- lower-stakes
// setup data, same precedent as expense-categories/tags.
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant"] as const;

router.post("/", requireRole(...writeRoles), createDepartment);
router.get("/", requireRole(...viewRoles), listDepartments);

export default router;
