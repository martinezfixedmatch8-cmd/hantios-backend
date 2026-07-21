import { Router } from "express";
import { requireCsrf } from "../middleware/csrf";
import {
  signupLimiter,
  loginLimiter,
  googleAuthLimiter,
  refreshLimiter,
  verifyEmailLimiter,
  verifyOtpLimiter,
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

export default router;
