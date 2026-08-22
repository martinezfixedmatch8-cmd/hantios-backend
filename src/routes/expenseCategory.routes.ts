import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import {
  createExpenseCategory,
  listExpenseCategories,
  updateExpenseCategory,
  deactivateExpenseCategory,
  restoreExpenseCategory,
} from "../controllers/expenseCategory.controller";

const router = Router();

router.use(authenticate);

// Literal spec: "Owner adds CUSTOM categories" -- owner-only for
// create/update/deactivate, unlike Expenses' own owner+manager create bar.
// Non-financial, low-stakes setup data -- no Idempotency-Key, matching
// Branches/PaymentMethods' convention rather than Sales/Debt's (a duplicate
// category-create attempt is a clean 400 on the name-uniqueness check, not a
// financial-state risk worth two-phase idempotency for).
router.post("/", requireRole("owner"), createExpenseCategory);
router.get("/", requireRole("owner", "manager", "accountant"), listExpenseCategories);
router.patch("/:id", requireRole("owner"), updateExpenseCategory);
router.post("/:id/deactivate", requireRole("owner"), deactivateExpenseCategory);
// Batch 6 (HNT2-EXP-001) -- owner-only, matching the existing bar; no
// Idempotency-Key (Option A not expanded to this entity).
router.post("/:id/restore", requireRole("owner"), restoreExpenseCategory);

export default router;
