import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { listUnmatchedInboundEmailsHandler } from "../controllers/unmatchedInboundEmail.controller";

// Module 33 Session 4B -- review endpoint for quarantined inbound emails.
// Owner/Manager only, per the locked spec -- same bar as every other
// financially/operationally-sensitive review surface in this repo.
const router = Router();

router.use(authenticate);

router.get("/", requireRole("owner", "manager"), listUnmatchedInboundEmailsHandler);

export default router;
