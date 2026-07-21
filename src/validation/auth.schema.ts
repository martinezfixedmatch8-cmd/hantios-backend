import { z } from "zod";
import { passwordSchema } from "../lib/password";

const phoneSchema = z.string().trim().regex(/^\+?[0-9]{7,15}$/, "Phone must be 7-15 digits, optionally prefixed with +");
const countrySchema = z.string().trim().length(2, "Country must be an ISO 3166-1 alpha-2 code").toUpperCase();
const overridesSchema = z.object({
  currency: z.string().trim().length(3).toUpperCase().optional(),
  timezone: z.string().trim().min(1).optional(),
  phonePrefix: z.string().trim().min(1).optional(),
});

const consentSchema = z.object({
  termsAccepted: z.literal(true, { message: "You must accept the Terms of Service" }),
  privacyAccepted: z.literal(true, { message: "You must accept the Privacy Policy" }),
});

// deviceId travels via the X-Device-Id header (per the schema's own documented convention
// for sessions.device_id), not the body -- validated separately in the controller.
export const signupSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("email"),
      businessName: z.string().trim().min(2).max(150),
      ownerFullName: z.string().trim().min(2).max(100),
      businessEmail: z.string().trim().toLowerCase().email(),
      phone: phoneSchema,
      password: passwordSchema,
      country: countrySchema,
      rememberMe: z.boolean().optional().default(false),
    })
    .extend(overridesSchema.shape)
    .extend(consentSchema.shape),
  z
    .object({
      provider: z.literal("google"),
      idToken: z.string().min(1),
      businessName: z.string().trim().min(2).max(150),
      ownerFullName: z.string().trim().min(2).max(100).optional(),
      phone: phoneSchema,
      country: countrySchema,
      rememberMe: z.boolean().optional().default(false),
    })
    .extend(overridesSchema.shape)
    .extend(consentSchema.shape),
]);
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const googleLoginSchema = z.object({
  idToken: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});
export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

export const googleIdentifySchema = z.object({
  idToken: z.string().min(1),
});
export type GoogleIdentifyInput = z.infer<typeof googleIdentifySchema>;

export const verifyDeviceOtpSchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
  rememberMe: z.boolean().optional().default(false),
});
export type VerifyDeviceOtpInput = z.infer<typeof verifyDeviceOtpSchema>;

export const verifySignupPhoneOtpSchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});
export type VerifySignupPhoneOtpInput = z.infer<typeof verifySignupPhoneOtpSchema>;

export const emailVerifyParamSchema = z.object({
  token: z.string().min(1),
});
