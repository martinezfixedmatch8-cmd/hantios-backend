import { randomUUID } from "crypto";
import request from "supertest";
import type { UserRole } from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { generateId } from "../../src/lib/ids";
import { signAccessToken } from "../../src/lib/jwt";
import { app } from "../../src/app";

export const TEST_PASSWORD = "Str0ng!Passw0rd";

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

// Goes through the real POST /auth/signup endpoint rather than inserting rows directly,
// so callers exercise the actual signup path -- used by tests (e.g. staff invitation's)
// that need a real owner session, not just an owner-shaped row.
export async function signupTestOwner(
  overrides: Partial<{
    businessName: string;
    ownerFullName: string;
    email: string;
    phone: string;
    password: string;
    country: string;
    deviceId: string;
  }> = {}
) {
  const email = overrides.email ?? uniqueEmail("signup-owner");
  const password = overrides.password ?? TEST_PASSWORD;
  const deviceId = overrides.deviceId ?? `test-device-${randomUUID()}`;

  const res = await request(app)
    .post("/auth/signup")
    .set("X-Device-Id", deviceId)
    .send({
      provider: "email",
      businessName: overrides.businessName ?? `Test Business ${randomUUID()}`,
      ownerFullName: overrides.ownerFullName ?? "Test Owner",
      businessEmail: email,
      phone: overrides.phone ?? `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
      password,
      country: overrides.country ?? "KE",
      termsAccepted: true,
      privacyAccepted: true,
    });

  if (res.status !== 201) {
    throw new Error(`signupTestOwner failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    businessId: res.body.data.business.id as string,
    ownerId: res.body.data.user.id as string,
    email,
    password,
    deviceId,
  };
}

export async function loginTestOwner(email: string, password: string, deviceId = `test-device-${randomUUID()}`) {
  const res = await request(app).post("/auth/login").set("X-Device-Id", deviceId).send({ email, password });

  if (res.status !== 200 || !res.body.data?.accessToken) {
    throw new Error(`loginTestOwner failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    accessToken: res.body.data.accessToken as string,
    setCookieHeader: res.headers["set-cookie"] as unknown as string[] | undefined,
    deviceId,
  };
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

export async function createTestBranch(
  businessId: string,
  overrides: Partial<{ name: string; location: string; managerId: string }> = {}
) {
  return prisma.branches.create({
    data: {
      id: generateId(),
      business_id: businessId,
      name: overrides.name ?? `Test Branch ${randomUUID()}`,
      location: overrides.location,
      manager_id: overrides.managerId,
    },
  });
}

export async function createTestPaymentMethod(
  businessId: string,
  overrides: Partial<{ name: string; accountNumber: string }> = {}
) {
  return prisma.payment_methods.create({
    data: {
      id: generateId(),
      business_id: businessId,
      name: overrides.name ?? `Test Payment Method ${randomUUID()}`,
      account_number: overrides.accountNumber,
    },
  });
}

export async function createTestProduct(
  businessId: string,
  overrides: Partial<{ name: string; costPrice: number; sellingPrice: number; categoryId: string; minStockLevel: number }> = {}
) {
  return prisma.products.create({
    data: {
      id: generateId(),
      business_id: businessId,
      name: overrides.name ?? `Test Product ${randomUUID()}`,
      cost_price: overrides.costPrice ?? 10,
      selling_price: overrides.sellingPrice ?? 20,
      category_id: overrides.categoryId,
      min_stock_level: overrides.minStockLevel,
    },
  });
}

export async function createTestCategory(businessId: string, overrides: Partial<{ name: string }> = {}) {
  return prisma.categories.create({
    data: {
      id: generateId(),
      business_id: businessId,
      name: overrides.name ?? `Test Category ${randomUUID()}`,
    },
  });
}

export async function createTestCustomer(
  businessId: string,
  overrides: Partial<{ phone: string; phoneNormalized: string; name: string; email: string; status: "active" | "archived" }> = {}
) {
  const phone = overrides.phone ?? `+2547${Math.floor(10000000 + Math.random() * 89999999)}`;
  return prisma.customers.create({
    data: {
      id: generateId(),
      business_id: businessId,
      // Bypasses the real customer_counters sequence for factory convenience
      // (matching how createTestProduct/etc. don't drive through their own
      // real service functions either) -- never asserted against in tests
      // that actually exercise the real numbering sequence themselves.
      customer_number: `CUS-TEST-${randomUUID().slice(0, 8)}`,
      phone_original: phone,
      phone_normalized: overrides.phoneNormalized ?? phone,
      name: overrides.name,
      email: overrides.email,
      status: overrides.status ?? "active",
    },
  });
}

export async function createTestSupplier(
  businessId: string,
  overrides: Partial<{ name: string; phone: string; email: string; status: "active" | "archived" }> = {}
) {
  return prisma.suppliers.create({
    data: {
      id: generateId(),
      business_id: businessId,
      name: overrides.name ?? `Test Supplier ${randomUUID()}`,
      phone: overrides.phone,
      email: overrides.email,
      status: overrides.status ?? "active",
    },
  });
}

export async function createTestBranchInventory(
  businessId: string,
  branchId: string,
  productId: string,
  overrides: Partial<{ size: string; quantity: number }> = {}
) {
  return prisma.branch_inventory.create({
    data: {
      id: generateId(),
      business_id: businessId,
      branch_id: branchId,
      product_id: productId,
      size: overrides.size,
      quantity: overrides.quantity ?? 0,
    },
  });
}
