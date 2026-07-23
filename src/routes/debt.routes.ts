import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createDebt,
  listDebts,
  getDebt,
  recordPayment,
  reversePayment,
  disputeDebt,
  resolveDisputeDebt,
  writeOffDebt,
  sendReminder,
} from "../controllers/debt.controller";

const router = Router();

router.use(authenticate);

// Create / record payment: mirrors Sales' create roles -- a debt is usually a
// credit sale, and the same roles typically collect a later payment too.
const writeRoles = ["owner", "manager", "cashier"] as const;
// List/get: mirrors Sales' read roles.
const readRoles = ["owner", "manager", "cashier", "accountant"] as const;
// Reverse/dispute/resolve/write-off: mirrors Refund's elevated bar -- real
// financial-consequence judgment calls, not routine data entry.
const elevatedRoles = ["owner", "manager"] as const;

router.post("/", requireRole(...writeRoles), requireIdempotencyKey, createDebt);
router.get("/", requireRole(...readRoles), listDebts);
router.get("/:id", requireRole(...readRoles), getDebt);
router.post("/:id/payments", requireRole(...writeRoles), requireIdempotencyKey, recordPayment);
router.post("/:id/payments/:paymentId/reverse", requireRole(...elevatedRoles), requireIdempotencyKey, reversePayment);
router.post("/:id/dispute", requireRole(...elevatedRoles), requireIdempotencyKey, disputeDebt);
router.post("/:id/resolve-dispute", requireRole(...elevatedRoles), requireIdempotencyKey, resolveDisputeDebt);
router.post("/:id/write-off", requireRole(...elevatedRoles), requireIdempotencyKey, writeOffDebt);
// Manual remind trigger: operational, low-risk -- same roles as create/payment.
router.post("/:id/remind", requireRole(...writeRoles), sendReminder);

export default router;
