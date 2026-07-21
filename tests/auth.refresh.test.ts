import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";
import { extractCookiePair, loginAndGetCookies } from "./helpers/cookies";

describe("POST /auth/refresh", () => {
  const businessIds: string[] = [];

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  it("rejects refresh with no cookies at all", async () => {
    const res = await request(app).post("/auth/refresh");
    expect(res.status).toBe(403); // CSRF middleware runs first, no csrf cookie/header present
  });

  it("rejects refresh with a missing/mismatched CSRF header", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    const missingHeader = await request(app).post("/auth/refresh").set("Cookie", [refresh.header, csrf.header]);
    expect(missingHeader.status).toBe(403);

    const mismatched = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", "wrong-value");
    expect(mismatched.status).toBe(403);
  });

  it("rotates the refresh token on the happy path, and the old token stops working", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    const res = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();

    const newSetCookie = res.headers["set-cookie"] as unknown as string[];
    const newRefresh = extractCookiePair(newSetCookie, "refresh_token");
    expect(newRefresh.value).not.toBe(refresh.value);

    // Replaying the OLD refresh token must fail -- its hash was overwritten by rotation.
    const replay = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);
    expect(replay.status).toBe(401);
  });

  it("rejects refresh for an expired session", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    await prisma.sessions.updateMany({
      where: { user_id: owner.ownerId },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);
    expect(res.status).toBe(401);
  });

  it("keeps expires_at sliding forward and Max-Age at 30d across repeated remember-me refreshes", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    let { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1", true);

    // Scoped to device_id "d1" -- signupTestOwner's own auto-login already created a
    // separate (non-remember-me) session on a different device.
    const session1 = await prisma.sessions.findFirst({ where: { user_id: owner.ownerId, device_id: "d1" } });
    expect(session1?.remember_me).toBe(true);

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/auth/refresh")
        .set("Cookie", [refresh.header, csrf.header])
        .set("X-CSRF-Token", csrf.value);
      expect(res.status).toBe(200);

      const setCookie = res.headers["set-cookie"] as unknown as string[];
      const refreshSetCookie = setCookie.find((c) => c.startsWith("refresh_token="))!;
      expect(refreshSetCookie).toMatch(/Max-Age=2592000/); // 30 days in seconds

      refresh = extractCookiePair(setCookie, "refresh_token");
      csrf = extractCookiePair(setCookie, "csrf_token");
    }

    const finalSession = await prisma.sessions.findFirst({ where: { user_id: owner.ownerId, device_id: "d1" } });
    const sevenDaysFromNow = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(finalSession!.expires_at.getTime() - sevenDaysFromNow)).toBeLessThan(60_000);
  });

  it("uses a 12h Max-Age when rememberMe is false", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1", false);

    const res = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);
    const refreshSetCookie = (res.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith("refresh_token=")
    )!;
    expect(refreshSetCookie).toMatch(/Max-Age=43200/); // 12 hours in seconds
  });
});
