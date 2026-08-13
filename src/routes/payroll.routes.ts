import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  listPayrollRecords,
  getPayrollRecord,
  markPayrollPaid,
  bulkPayPending,
  generatePayroll,
  createPayrollReversal,
} from "../controllers/payroll.controller";

const router = Router();

router.use(authenticate);

// Module 12 Session A -- write (mark-paid/bulk-pay/generate) = owner/manager
// only (moves real money, matches the elevated bar Sale Refund/Debt
// write-off/PO Payment already use), view = owner/manager/accountant.
// Idempotency-Key required ONLY on mark-paid and bulk-pay, per the locked
// spec's own explicit list -- generate is naturally idempotent (atomic
// INSERT ... ON CONFLICT DO NOTHING underneath), no key needed.
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant"] as const;

router.get("/", requireRole(...viewRoles), listPayrollRecords);
router.get("/:id", requireRole(...viewRoles), getPayrollRecord);
router.post("/:id/mark-paid", requireRole(...writeRoles), requireIdempotencyKey, markPayrollPaid);
router.post("/pay-all-pending", requireRole(...writeRoles), requireIdempotencyKey, bulkPayPending);
router.post("/generate", requireRole(...writeRoles), generatePayroll);
// Module 12 Session D, Locked Decision #3 -- owner/manager only, same
// elevated bar as every other correction endpoint in this repo.
router.post("/:id/reversals", requireRole(...writeRoles), requireIdempotencyKey, createPayrollReversal);

export default router;
