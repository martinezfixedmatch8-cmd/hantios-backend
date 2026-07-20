import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { generateId } from "../../src/lib/ids";
import { signAccessToken } from "../../src/lib/jwt";

// Random local part so a crashed run that skips afterAll doesn't collide with the
// next run -- users.email is globally unique.
function uniqueEmail(label: string): string {
  return `test-${label}-${randomUUID()}@example.test`;
}

export async function createTestBusiness(overrides: Partial<{ name: string }> = {}) {
  return prisma.businesses.create({
    data: {
      id: generateId(),
      name: overrides.name ?? `Test Business ${randomUUID()}`,
      plan: "starter",
      tier: "tier1",
      country: "KE",
      phone_prefix: "+254",
      timezone: "Africa/Nairobi",
      currency: "KES",
    },
  });
}

export async function createTestOwner(businessId: string) {
  const now = new Date();
  return prisma.users.create({
    data: {
      id: generateId(),
      business_id: businessId,
      name: "Test Owner",
      email: uniqueEmail("owner"),
      phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
      role: "owner",
      status: "active",
      // Signup isn't built yet in this pass -- fabricated consent stamps stand in for
      // what a real signup flow would have recorded.
      terms_accepted_at: now,
      terms_version: "1.0",
      privacy_accepted_at: now,
      privacy_version: "1.0",
    },
  });
}

export async function createTestUser(businessId: string, role: UserRole) {
  const now = new Date();
  return prisma.users.create({
    data: {
      id: generateId(),
      business_id: businessId,
      name: `Test ${role}`,
      email: uniqueEmail(role),
      phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
      role,
      status: "active",
      terms_accepted_at: now,
      terms_version: "1.0",
      privacy_accepted_at: now,
      privacy_version: "1.0",
    },
  });
}

export function mintAccessToken(user: { id: string; business_id: string; role: UserRole; name: string }): string {
  return signAccessToken({ sub: user.id, businessId: user.business_id, role: user.role, name: user.name });
}

export async function createTestInvite(
  businessId: string,
  invitedBy: string,
  overrides: Partial<{
    token: string;
    email: string;
    role: UserRole;
    expiresAt: Date;
    revokedAt: Date | null;
    acceptedAt: Date | null;
  }> = {}
) {
  return prisma.staff_invites.create({
    data: {
      id: generateId(),
      business_id: businessId,
      email: overrides.email ?? uniqueEmail("invitee"),
      full_name: "Test Invitee",
      phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
      role: overrides.role ?? "cashier",
      token: overrides.token ?? generateId().replace(/-/g, ""),
      invited_by: invitedBy,
      expires_at: overrides.expiresAt ?? new Date(Date.now() + 72 * 60 * 60 * 1000),
      revoked_at: overrides.revokedAt ?? null,
      accepted_at: overrides.acceptedAt ?? null,
    },
  });
}
