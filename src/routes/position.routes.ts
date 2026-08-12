import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { createPosition, listPositions } from "../controllers/position.controller";

const router = Router();

router.use(authenticate);

const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant"] as const;

router.post("/", requireRole(...writeRoles), createPosition);
router.get("/", requireRole(...viewRoles), listPositions);

export default router;
