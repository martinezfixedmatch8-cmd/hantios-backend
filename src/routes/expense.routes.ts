import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createExpense,
  listExpenses,
  getExpense,
  updateExpense,
  archiveExpense,
  restoreExpense,
  addAttachments,
  deleteAttachment,
  approveExpense,
  rejectExpense,
  markExpensePaid,
  updateRecurrence,
} from "../controllers/expense.controller";

const router = Router();

router.use(authenticate);

// Cashier: ZERO access anywhere (locked -- Cashier is POS-only).
// Storekeeper/shareholder/custom: ZERO access anywhere (locked).
const writeRoles = ["owner", "manager"] as const;
const readRoles = ["owner", "manager", "accountant"] as const;

router.post("/", requireRole(...writeRoles), requireIdempotencyKey, createExpense);
router.get("/", requireRole(...readRoles), listExpenses);
router.get("/:id", requireRole(...readRoles), getExpense);
router.patch("/:id", requireRole(...writeRoles), requireIdempotencyKey, updateExpense);
// POST /:id/archive (not DELETE /:id) -- matches Debts' write-off/dispute
// shape (body carries version+reason, Idempotency-Key required), the newer,
// more rigorous pattern this session is asked to match, not the older bare
// DELETE convention Branches/PaymentMethods used before optimistic
// locking/idempotency existed in this repo.
router.post("/:id/archive", requireRole(...writeRoles), requireIdempotencyKey, archiveExpense);
router.post("/:id/restore", requireRole(...writeRoles), requireIdempotencyKey, restoreExpense);
router.post("/:id/attachments", requireRole(...writeRoles), requireIdempotencyKey, addAttachments);
router.delete("/:id/attachments/:attachmentId", requireRole(...writeRoles), requireIdempotencyKey, deleteAttachment);
// Session 5B status workflow -- single-step transitions only, owner+manager
// (matching every other elevated Expenses action; not explicitly stated in
// the spec, flagged as the assumed default in CLAUDE.md).
router.post("/:id/approve", requireRole(...writeRoles), requireIdempotencyKey, approveExpense);
router.post("/:id/reject", requireRole(...writeRoles), requireIdempotencyKey, rejectExpense);
router.post("/:id/mark-paid", requireRole(...writeRoles), requireIdempotencyKey, markExpensePaid);
// Recurrence schedule management -- architecture-only, no scheduler reads it.
router.patch("/:id/recurrence", requireRole(...writeRoles), requireIdempotencyKey, updateRecurrence);

export default router;
