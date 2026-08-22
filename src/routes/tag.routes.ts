import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { createTag, listTags, getTag, updateTag, archiveTag, restoreTag } from "../controllers/tag.controller";

const router = Router();

router.use(authenticate);

// Filter-only, low-stakes setup data -- same RBAC bar as expense categories.
// Batch 6 (HNT2-MASTER-001) -- create now requires Idempotency-Key
// (Option A); rename is version-guarded only; archive/restore require both.
router.post("/", requireRole("owner", "manager"), requireIdempotencyKey, createTag);
router.get("/", requireRole("owner", "manager", "accountant"), listTags);
router.get("/:id", requireRole("owner", "manager", "accountant"), getTag);
router.patch("/:id", requireRole("owner", "manager"), updateTag);
router.post("/:id/archive", requireRole("owner", "manager"), requireIdempotencyKey, archiveTag);
router.post("/:id/restore", requireRole("owner", "manager"), requireIdempotencyKey, restoreTag);

export default router;
