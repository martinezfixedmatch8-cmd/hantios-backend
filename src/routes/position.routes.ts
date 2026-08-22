import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createPosition,
  listPositions,
  getPosition,
  updatePosition,
  archivePosition,
  restorePosition,
} from "../controllers/position.controller";

const router = Router();

router.use(authenticate);

const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant"] as const;

// Batch 6 (HNT2-HR-001) -- create now requires Idempotency-Key (Option A);
// PATCH is version-guarded only; archive/restore require both.
router.post("/", requireRole(...writeRoles), requireIdempotencyKey, createPosition);
router.get("/", requireRole(...viewRoles), listPositions);
router.get("/:id", requireRole(...viewRoles), getPosition);
router.patch("/:id", requireRole(...writeRoles), updatePosition);
router.post("/:id/archive", requireRole(...writeRoles), requireIdempotencyKey, archivePosition);
router.post("/:id/restore", requireRole(...writeRoles), requireIdempotencyKey, restorePosition);

export default router;
