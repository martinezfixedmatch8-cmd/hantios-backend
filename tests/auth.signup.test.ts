import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { SpyNotificationProvider } from "./helpers/notificationSpy";
import { setNotificationProvider } from "../src/notifications/registry";

const TEST_PASSWORD = "Str0ng!Passw0rd";

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    provider: "email",
    businessName: `Signup Test Biz ${randomUUID()}`,
    ownerFullName: "Signup Owner",
    businessEmail: `signup-${randomUUID()}@example.test`,
    phone: "+254712345678",
    password: TEST_PASSWORD,
    country: "KE",
    termsAccepted: true,
    privacyAccepted: true,
    ...overrides,
  };
}

describe("POST /auth/signup (email path)", () => {
  const businessIds: string[] = [];
  let spy: SpyNotificationProvider;

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  beforeEach(() => {
    spy = new SpyNotificationProvider();
    setNotificationProvider(spy);
  });

  it("returns 400 without an X-Device-Id header", async () => {
    const res = await request(app).post("/auth/signup").send(validPayload());
    expect(res.status).toBe(400);
  });

  it("returns 400 for a weak password", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .set("X-Device-Id", "d1")
      .send(validPayload({ password: "weak" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when consent is missing", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .set("X-Device-Id", "d1")
      .send(validPayload({ termsAccepted: false }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown country code", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .set("X-Device-Id", "d1")
      .send(validPayload({ country: "ZZ" }));
    expect(res.status).toBe(400);
  });

  it("creates a business + owner on the happy path", async () => {
    const payload = validPayload();
    const res = await request(app).post("/auth/signup").set("X-Device-Id", "d1").send(payload);

    expect(res.status).toBe(201);
    businessIds.push(res.body.data.business.id);
    expect(res.body.data.user).toMatchObject({
      name: payload.ownerFullName,
      email: payload.businessEmail,
      role: "owner",
    });
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.rawRefreshToken).toBeUndefined();

    const business = await prisma.businesses.findUnique({ where: { id: res.body.data.business.id } });
    expect(business).toMatchObject({
      tier: "tier1",
      plan: "starter",
      country: "KE",
      currency: "KES",
      timezone: "Africa/Nairobi",
      phone_prefix: "+254",
    });
    expect(business?.owner_id).toBe(res.body.data.user.id);

    const user = await prisma.users.findUnique({ where: { id: res.body.data.user.id } });
    expect(user?.password_hash).toBeTruthy();
    expect(user?.terms_accepted_at).not.toBeNull();
    expect(user?.privacy_accepted_at).not.toBeNull();
    expect(user?.email_verified_at).toBeNull();
    expect(user?.phone_verified_at).toBeNull();

    const history = await prisma.password_history.findMany({ where: { user_id: user!.id } });
    expect(history).toHaveLength(1);

    const auditRows = await prisma.audit_logs.findMany({
      where: { business_id: business!.id, action: "auth.signup" },
    });
    expect(auditRows).toHaveLength(1);

    expect(spy.sent).toHaveLength(2);
    expect(spy.sent.find((n) => n.channel === "whatsapp")).toMatchObject({
      category: "TRANSACTIONAL",
      to: payload.phone,
    });
    expect(spy.sent.find((n) => n.channel === "email")).toMatchObject({
      category: "TRANSACTIONAL",
      to: payload.businessEmail,
    });

    const setCookie = res.headers["set-cookie"] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith("refresh_token=") && c.includes("HttpOnly"))).toBe(true);
    expect(setCookie.some((c) => c.startsWith("csrf_token=") && !c.includes("HttpOnly"))).toBe(true);
  });

  it("allows overriding currency/timezone/phonePrefix over the country defaults", async () => {
    const payload = validPayload({ currency: "USD", timezone: "UTC", phonePrefix: "+1" });
    const res = await request(app).post("/auth/signup").set("X-Device-Id", "d1").send(payload);

    expect(res.status).toBe(201);
    businessIds.push(res.body.data.business.id);
    const business = await prisma.businesses.findUnique({ where: { id: res.body.data.business.id } });
    expect(business).toMatchObject({ currency: "USD", timezone: "UTC", phone_prefix: "+1" });
  });

  it("returns 409 for a duplicate business email", async () => {
    const payload = validPayload();
    const first = await request(app).post("/auth/signup").set("X-Device-Id", "d1").send(payload);
    expect(first.status).toBe(201);
    businessIds.push(first.body.data.business.id);

    const second = await request(app).post("/auth/signup").set("X-Device-Id", "d2").send(payload);
    expect(second.status).toBe(409);
  });

  it("only lets one of two concurrent same-email signups win, with no 500 and no orphaned business", async () => {
    const payload = validPayload();

    const [first, second] = await Promise.all([
      request(app).post("/auth/signup").set("X-Device-Id", "d1").send(payload),
      request(app).post("/auth/signup").set("X-Device-Id", "d2").send(payload),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = first.status === 201 ? first : second;
    businessIds.push(winner.body.data.business.id);

    const users = await prisma.users.findMany({ where: { email: payload.businessEmail } });
    expect(users).toHaveLength(1);

    const orphanedBusinesses = await prisma.businesses.findMany({ where: { name: payload.businessName } });
    expect(orphanedBusinesses).toHaveLength(1);
    expect(orphanedBusinesses[0].owner_id).not.toBeNull();
  });
});
