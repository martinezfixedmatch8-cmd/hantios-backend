import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
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

router.post("/", createBranch);
router.get("/", listBranches);
router.get("/:id", getBranch);
router.patch("/:id", updateBranch);
router.delete("/:id", archiveBranch);
router.post("/:id/restore", restoreBranch);

export default router;
