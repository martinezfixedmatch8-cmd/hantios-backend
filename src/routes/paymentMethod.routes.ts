import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createPaymentMethod,
  listPaymentMethods,
  getPaymentMethod,
  updatePaymentMethod,
  archivePaymentMethod,
  restorePaymentMethod,
} from "../controllers/paymentMethod.controller";

const router = Router();

router.use(authenticate, requireRole("owner", "manager"));

// Batch 6 (HNT2-MD-001) -- existing route paths and response envelopes
// preserved exactly; create/archive/restore now require Idempotency-Key
// (Option A), PATCH gains a version guard only.
router.post("/", requireIdempotencyKey, createPaymentMethod);
router.get("/", listPaymentMethods);
router.get("/:id", getPaymentMethod);
router.patch("/:id", updatePaymentMethod);
router.delete("/:id", requireIdempotencyKey, archivePaymentMethod);
router.post("/:id/restore", requireIdempotencyKey, restorePaymentMethod);

export default router;
