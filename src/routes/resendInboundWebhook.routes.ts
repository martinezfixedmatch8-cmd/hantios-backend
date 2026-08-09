import { Router } from "express";
import { resendWebhookLimiter } from "../middleware/rateLimit";
import { handleResendInboundWebhook } from "../controllers/resendInboundWebhook.controller";

// Module 33 Session 4B -- mounted at /api/webhooks in app.ts, BEFORE the
// app-wide express.json(), with express.raw() applied to this exact mount
// point (signature verification needs the untouched raw bytes). No
// authenticate()/requireRole() -- this is Resend's own infrastructure
// calling us, not a logged-in user; verifyResendWebhookSignature is the
// only gate, enforced inside the controller itself.
const router = Router();

router.post("/resend-inbound", resendWebhookLimiter, handleResendInboundWebhook);

export default router;
