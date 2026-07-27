import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { createTag, listTags } from "../controllers/tag.controller";

const router = Router();

router.use(authenticate);

// Filter-only, low-stakes setup data -- same RBAC bar and no-Idempotency-Key
// convention as expense categories, not Expenses' own stricter financial bar.
router.post("/", requireRole("owner", "manager"), createTag);
router.get("/", requireRole("owner", "manager", "accountant"), listTags);

export default router;
