import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { createTestUser, mintAccessToken, signupTestOwner, loginTestOwner } from "./helpers/factories";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { SpyNotificationProvider } from "./helpers/notificationSpy";
import { setNotificationProvider } from "../src/notifications/registry";
import { generateSecureToken } from "../src/lib/tokens";

describe("POST /staff/invite", () => {
  let businessId: string;
  let ownerToken: string;
  let spy: SpyNotificationProvider;

  beforeAll(async () => {
    // Goes through the real signup -> login flow now that Auth exists, rather than
    // constructing an owner-shaped row and hand-minting a token.
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;
  });

  afterAll(async () => {
    await cleanupTestBusiness(businessId);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    spy = new SpyNotificationProvider();
    setNotificationProvider(spy);
  });

  const validPayload = () => ({
    fullName: "Jane Doe",
    email: `invitee-${generateSecureToken(4)}@example.test`,
    phone: "+254712345678",
    role: "cashier",
  });

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/staff/invite").send(validPayload());
    expect(res.status).toBe(401);
  });

  it("returns 401 with an invalid token", async () => {
    const res = await request(app)
      .post("/staff/invite")
      .set("Authorization", "Bearer not-a-real-token")
      .send(validPayload());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not an owner", async () => {
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);
    const res = await request(app)
      .post("/staff/invite")
      .set("Authorization", `Bearer ${token}`)
      .send(validPayload());
    expect(res.status).toBe(403);
  });

  it("allows super_admin to bypass the owner-only restriction", async () => {
    const admin = await createTestUser(businessId, "super_admin");
    const token = mintAccessToken(admin);
    const res = await request(app)
      .post("/staff/invite")
      .set("Authorization", `Bearer ${token}`)
      .send(validPayload());
    expect(res.status).toBe(201);
  });

  it("returns 400 on missing fields", async () => {
    const res = await request(app)
      .post("/staff/invite")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ fullName: "Jane Doe" });
    expect(res.status).toBe(400);
  });

  it.each(["owner", "super_admin"])("returns 400 when role=%s is requested", async (role) => {
    const res = await request(app)
      .post("/staff/invite")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...validPayload(), role });
    expect(res.status).toBe(400);
  });

  it("creates an invite and sends a TRANSACTIONAL email on the happy path", async () => {
    const payload = validPayload();
    const res = await request(app)
      .post("/staff/invite")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ fullName: payload.fullName, email: payload.email, role: payload.role });
    expect(res.body.data.token).toBeUndefined();

    const dbInvite = await prisma.staff_invites.findUnique({ where: { id: res.body.data.id } });
    expect(dbInvite).not.toBeNull();
    expect(dbInvite?.user_id).toBeNull();
    expect(dbInvite?.token).toHaveLength(64);

    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0]).toMatchObject({ category: "TRANSACTIONAL", channel: "email", to: payload.email });
    expect(spy.sent[0].body).toContain(dbInvite?.token);
  });

  it("returns 409 for a duplicate pending invite", async () => {
    const payload = validPayload();
    const first = await request(app)
      .post("/staff/invite")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/staff/invite")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send(payload);
    expect(second.status).toBe(409);
  });

  it("returns 409 when the email already belongs to an existing user", async () => {
    const existing = await createTestUser(businessId, "cashier");
    const res = await request(app)
      .post("/staff/invite")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...validPayload(), email: existing.email });
    expect(res.status).toBe(409);
  });
});
