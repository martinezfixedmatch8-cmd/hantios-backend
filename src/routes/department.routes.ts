import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createDepartment,
  listDepartments,
  getDepartment,
  updateDepartment,
  archiveDepartment,
  restoreDepartment,
} from "../controllers/department.controller";

const router = Router();

router.use(authenticate);

// Module 12 Session A -- RBAC confirmed: write = owner/manager, view adds
// accountant (matches the spec's own "Accountant: Finance only -- P&L,
// cash flow, payroll, debt reports").
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant"] as const;

// Batch 6 (HNT2-HR-001) -- create now requires Idempotency-Key (Option A);
// PATCH is version-guarded only (no key needed); archive/restore require
// both.
router.post("/", requireRole(...writeRoles), requireIdempotencyKey, createDepartment);
router.get("/", requireRole(...viewRoles), listDepartments);
router.get("/:id", requireRole(...viewRoles), getDepartment);
router.patch("/:id", requireRole(...writeRoles), updateDepartment);
router.post("/:id/archive", requireRole(...writeRoles), requireIdempotencyKey, archiveDepartment);
router.post("/:id/restore", requireRole(...writeRoles), requireIdempotencyKey, restoreDepartment);

export default router;
