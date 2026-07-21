import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, TEST_PASSWORD, createTestBusiness, createTestUser } from "./helpers/factories";

describe("POST /auth/login (password path)", () => {
  const businessIds: string[] = [];

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  it("returns 400 without an X-Device-Id header", async () => {
    const res = await request(app).post("/auth/login").send({ email: "a@example.test", password: "x" });
    expect(res.status).toBe(400);
  });

  it("returns 401 for an unknown email", async () => {
    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "d1")
      .send({ email: "no-such-user@example.test", password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a wrong password, and logs a failed login_event", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);

    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "d1")
      .send({ email: owner.email, password: "WrongPassword1!" });
    expect(res.status).toBe(401);

    const events = await prisma.login_events.findMany({ where: { user_id: owner.ownerId, success: false } });
    expect(events).toHaveLength(1);

    const user = await prisma.users.findUnique({ where: { id: owner.ownerId } });
    expect(user?.failed_login_attempts).toBe(1);
  });

  it("logs in successfully and resets a prior failed-attempt count", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);

    await request(app).post("/auth/login").set("X-Device-Id", "d1").send({ email: owner.email, password: "wrong1" });
    await request(app).post("/auth/login").set("X-Device-Id", "d1").send({ email: owner.email, password: "wrong2" });

    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "d1")
      .send({ email: owner.email, password: owner.password });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: owner.ownerId, email: owner.email, role: "owner" });
    expect(res.body.data.accessToken).toBeTruthy();

    const user = await prisma.users.findUnique({ where: { id: owner.ownerId } });
    expect(user?.failed_login_attempts).toBe(0);
    expect(user?.last_login).not.toBeNull();

    const successEvents = await prisma.login_events.findMany({ where: { user_id: owner.ownerId, success: true } });
    expect(successEvents).toHaveLength(1);
    expect(successEvents[0].method).toBe("password");

    const setCookie = res.headers["set-cookie"] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith("refresh_token="))).toBe(true);
  });

  it("locks the account after 5 failed attempts and rejects even the correct password", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/auth/login")
        .set("X-Device-Id", "d1")
        .send({ email: owner.email, password: "wrong-password" });
    }

    const user = await prisma.users.findUnique({ where: { id: owner.ownerId } });
    expect(user?.locked_until).not.toBeNull();

    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "d1")
      .send({ email: owner.email, password: owner.password });
    expect(res.status).toBe(423);
  });

  it("rejects password login for a Google-only account (no password set)", async () => {
    // Constructed directly (not via signup) since this pass's Google signup always
    // requires a real/fake-provider round trip -- the state under test is just
    // "password_hash is null", which is simplest to set up this way.
    const business = await createTestBusiness();
    businessIds.push(business.id);
    const googleUser = await createTestUser(business.id, "owner");

    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "d1")
      .send({ email: googleUser.email, password: "SomePassword1!" });
    expect(res.status).toBe(401);
  });
});
