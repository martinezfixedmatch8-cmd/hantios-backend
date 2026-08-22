import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import {
  createBranch,
  listBranches,
  getBranch,
  updateBranch,
  archiveBranch,
  restoreBranch,
} from "../controllers/branch.controller";

const router = Router();

router.use(authenticate, requireRole("owner", "manager"));

// Batch 6 (HNT2-MD-001) -- existing route paths and response envelopes
// preserved exactly; create/archive/restore now require Idempotency-Key
// (Option A), PATCH gains a version guard only.
router.post("/", requireIdempotencyKey, createBranch);
router.get("/", listBranches);
router.get("/:id", getBranch);
router.patch("/:id", updateBranch);
router.delete("/:id", requireIdempotencyKey, archiveBranch);
router.post("/:id/restore", requireIdempotencyKey, restoreBranch);

export default router;
