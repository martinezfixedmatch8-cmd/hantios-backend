import rateLimit from "express-rate-limit";
import { env } from "../lib/config";

const isTestEnv = env.NODE_ENV === "test";

export const inviteCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isTestEnv ? 10_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
});

export const inviteTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10_000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
});
