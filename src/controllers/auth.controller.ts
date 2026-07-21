import type { Request, Response, NextFunction } from "express";
import { badRequest, unauthorized } from "../lib/errors";
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE_NAME } from "../lib/session";
import {
  signupSchema,
  loginSchema,
  googleLoginSchema,
  googleIdentifySchema,
  verifyDeviceOtpSchema,
  verifySignupPhoneOtpSchema,
  emailVerifyParamSchema,
} from "../validation/auth.schema";
import * as authService from "../services/auth.service";
import { verifyEmail } from "../services/emailVerification.service";

function getDeviceId(req: Request): string {
  const deviceId = req.get("x-device-id");
  if (!deviceId) {
    throw badRequest("X-Device-Id header is required");
  }
  return deviceId;
}

function getRequestMeta(req: Request) {
  return { deviceId: getDeviceId(req), ipAddress: req.ip, userAgent: req.get("user-agent") };
}

function getRefreshCookie(req: Request): string {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) {
    throw unauthorized("No active session");
  }
  return token;
}

export async function signup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = signupSchema.parse(req.body);
    const result = await authService.signup(input, getRequestMeta(req));
    setAuthCookies(res, { rawRefreshToken: result.rawRefreshToken, rememberMe: result.rememberMe });
    res.status(201).json({ data: { accessToken: result.accessToken, user: result.user, business: result.business } });
  } catch (err) {
    next(err);
  }
}

export async function verifySignupPhoneOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = verifySignupPhoneOtpSchema.parse(req.body);
    await authService.verifySignupPhoneOtp(input);
    res.status(200).json({ data: { verified: true } });
  } catch (err) {
    next(err);
  }
}

export async function verifyEmailController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = emailVerifyParamSchema.parse(req.params);
    const result = await verifyEmail(token);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input, getRequestMeta(req));
    if ("requiresOtp" in result) {
      res.status(200).json({ data: result });
      return;
    }
    setAuthCookies(res, { rawRefreshToken: result.rawRefreshToken, rememberMe: result.rememberMe });
    res.status(200).json({ data: { accessToken: result.accessToken, user: result.user, business: result.business } });
  } catch (err) {
    next(err);
  }
}

export async function googleIdentify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = googleIdentifySchema.parse(req.body);
    const result = await authService.googleIdentify(input);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function googleLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = googleLoginSchema.parse(req.body);
    const result = await authService.googleLogin(input, getRequestMeta(req));
    if ("requiresOtp" in result) {
      res.status(200).json({ data: result });
      return;
    }
    setAuthCookies(res, { rawRefreshToken: result.rawRefreshToken, rememberMe: result.rememberMe });
    res.status(200).json({ data: { accessToken: result.accessToken, user: result.user, business: result.business } });
  } catch (err) {
    next(err);
  }
}

export async function verifyDeviceOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = verifyDeviceOtpSchema.parse(req.body);
    const result = await authService.verifyDeviceOtp(input, getRequestMeta(req));
    setAuthCookies(res, { rawRefreshToken: result.rawRefreshToken, rememberMe: result.rememberMe });
    res.status(200).json({ data: { accessToken: result.accessToken, user: result.user, business: result.business } });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rawRefreshToken = getRefreshCookie(req);
    const result = await authService.refresh(rawRefreshToken, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
    setAuthCookies(res, { rawRefreshToken: result.rawRefreshToken, rememberMe: result.rememberMe });
    res.status(200).json({ data: { accessToken: result.accessToken } });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rawRefreshToken = getRefreshCookie(req);
    await authService.logout(rawRefreshToken);
    clearAuthCookies(res);
    res.status(200).json({ data: { loggedOut: true } });
  } catch (err) {
    next(err);
  }
}
