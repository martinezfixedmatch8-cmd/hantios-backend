import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { createCommissionAdjustment } from "../controllers/commission.controller";

const router = Router();

router.use(authenticate);

// Module 12 Session C -- owner/manager only, the same elevated bar every
// other financial-correction action in this repo uses (Refund, Write-off,
// Reject, Sale Attribution's own correction endpoint).
router.post("/", requireRole("owner", "manager"), requireIdempotencyKey, createCommissionAdjustment);

export default router;
