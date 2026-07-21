import type { Prisma } from "@prisma/client";

// Settings -> Security -> "Require OTP for New Devices" toggle, per the locked Auth
// Architecture spec. Business.settings is an arbitrary JSONB catch-all, so this reads
// defensively rather than assuming shape.
export function requiresOtpForNewDevices(settings: Prisma.JsonValue): boolean {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return false;
  }
  const security = (settings as Record<string, unknown>).security;
  if (typeof security !== "object" || security === null || Array.isArray(security)) {
    return false;
  }
  return (security as Record<string, unknown>).requireOtpForNewDevices === true;
}
