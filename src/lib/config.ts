import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_OTP_SECRET: z.string().min(32, "JWT_OTP_SECRET must be at least 32 characters"),
  JWT_RESET_SECRET: z.string().min(32, "JWT_RESET_SECRET must be at least 32 characters"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),

  APP_BASE_URL: z.string().url().optional(),
  STAFF_INVITE_EXPIRY_HOURS: z.coerce.number().int().positive().default(72),
  EMAIL_VERIFICATION_EXPIRY_HOURS: z.coerce.number().int().positive().default(24),

  // Module 33 Session 4A -- Real Email Sending. Both optional: absence is a
  // valid, fail-soft state (src/notifications/registry.ts falls back to
  // ConsoleEmailProvider when RESEND_API_KEY is unset), never a startup
  // failure -- matching this repo's existing GOOGLE_CLIENT_ID/
  // TURNSTILE_SECRET_KEY precedent for optional integrations.
  RESEND_API_KEY: z.string().optional(),
  // Accepts either a bare address or Resend's "Display Name <addr>" format,
  // so not validated as a strict email -- also doubles as the NOREPLY
  // sender-profile address override (src/notifications/senderProfiles.ts)
  // and what the startup domain-verification check inspects.
  RESEND_FROM_EMAIL: z.string().optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  if (parsed.data.NODE_ENV === "production") {
    const missing: string[] = [];
    if (!parsed.data.APP_BASE_URL) missing.push("APP_BASE_URL (used to build links sent in emails)");
    if (!parsed.data.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID (required for Google sign-in)");
    if (missing.length > 0) {
      console.error("Invalid environment configuration:");
      for (const m of missing) console.error(`  - ${m} is required in production`);
      process.exit(1);
    }
  }
  return parsed.data;
}

const parsedEnv = loadEnv();

export const env = {
  ...parsedEnv,
  APP_BASE_URL: parsedEnv.APP_BASE_URL ?? `http://localhost:${parsedEnv.PORT}`,
  CORS_ORIGIN_LIST: parsedEnv.CORS_ORIGINS
    ? parsedEnv.CORS_ORIGINS.split(",").map((origin) => origin.trim())
    : undefined,
};

export const CURRENT_TERMS_VERSION = "1.0";
export const CURRENT_PRIVACY_VERSION = "1.0";
