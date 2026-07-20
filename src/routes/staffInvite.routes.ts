import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { inviteCreateLimiter, inviteTokenLimiter } from "../middleware/rateLimit";
import { createInvite, previewInvite, acceptInvite } from "../controllers/staffInvite.controller";

const router = Router();

router.post("/invite", inviteCreateLimiter, authenticate, requireRole("owner"), createInvite);
router.get("/invite/:token", inviteTokenLimiter, previewInvite);
router.post("/invite/:token/accept", inviteTokenLimiter, acceptInvite);

export default router;
