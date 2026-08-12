import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  recordAttendance,
  bulkRecordAttendance,
  listAttendanceRecords,
  getAttendanceRecord,
  createAttendanceAdjustment,
} from "../controllers/attendance.controller";

const router = Router();

router.use(authenticate);

// Module 12 Session B -- confirmed Phase 0 (Q1): record/approve (collapsed
// into one action) and adjustment = owner/manager only, the identical bar
// Session A already uses for Employee CRUD's own write actions. View =
// owner/manager/accountant, matching Payroll's own view bar (Accountant is
// "Finance only... payroll" per the RBAC table -- Approved Hours directly
// feeds payroll).
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant"] as const;

router.post("/", requireRole(...writeRoles), requireIdempotencyKey, recordAttendance);
router.post("/bulk", requireRole(...writeRoles), requireIdempotencyKey, bulkRecordAttendance);
router.get("/", requireRole(...viewRoles), listAttendanceRecords);
router.get("/:id", requireRole(...viewRoles), getAttendanceRecord);
router.post("/:id/adjustments", requireRole(...writeRoles), requireIdempotencyKey, createAttendanceAdjustment);

export default router;
