import { Router } from "express";
import { requireCsrf } from "../middleware/csrf";
import { authenticate } from "../middleware/authenticate";
import {
  signupLimiter,
  loginLimiter,
  googleAuthLimiter,
  refreshLimiter,
  verifyEmailLimiter,
  verifyOtpLimiter,
  passwordResetRequestLimiter,
} from "../middleware/rateLimit";
import {
  signup,
  verifySignupPhoneOtp,
  verifyEmailController,
  login,
  googleIdentify,
  googleLogin,
  verifyDeviceOtp,
  refresh,
  logout,
  logoutAll,
  forgotPassword,
  resetPassword,
} from "../controllers/auth.controller";

const router = Router();

router.post("/signup", signupLimiter, signup);
router.post("/signup/verify-phone-otp", verifyOtpLimiter, verifySignupPhoneOtp);
router.get("/verify-email/:token", verifyEmailLimiter, verifyEmailController);

router.post("/login", loginLimiter, login);
router.post("/login/verify-device-otp", verifyOtpLimiter, verifyDeviceOtp);

router.post("/google/identify", googleAuthLimiter, googleIdentify);
router.post("/google/login", googleAuthLimiter, googleLogin);

router.post("/refresh", refreshLimiter, requireCsrf, refresh);
router.post("/logout", requireCsrf, logout);
// Batch 2 remediation (HNT2-AUTH-001) -- authenticated via Bearer token
// (authenticate), not the ambient refresh cookie, so this is not CSRF-gated
// the same way /refresh and /logout are -- a cross-origin request can't
// forge the Authorization header the way it can rely on auto-attached
// cookies. Matches every other regular protected route's own auth bar.
router.post("/logout-all", authenticate, logoutAll);

// Batch 2 remediation (HNT-AUTH-003) -- public, pre-login by design (the
// whole point is recovering access without already being logged in). The
// token itself is the credential; no Bearer/CSRF applies to either route.
router.post("/forgot-password", passwordResetRequestLimiter, forgotPassword);
router.post("/reset-password", passwordResetRequestLimiter, resetPassword);

export default router;
