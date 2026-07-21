import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";
import { loginAndGetCookies } from "./helpers/cookies";

describe("POST /auth/logout", () => {
  const businessIds: string[] = [];

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  it("requires CSRF", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    const res = await request(app).post("/auth/logout").set("Cookie", [refresh.header, csrf.header]);
    expect(res.status).toBe(403);
  });

  it("revokes the session and clears both cookies", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    const res = await request(app)
      .post("/auth/logout")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);
    expect(res.status).toBe(200);

    // Scoped to device_id "d1" specifically -- signupTestOwner's own auto-login already
    // created a separate session on a different device, so an unscoped lookup would be
    // ambiguous about which session it's checking.
    const session = await prisma.sessions.findFirst({ where: { user_id: owner.ownerId, device_id: "d1" } });
    expect(session?.revoked_at).not.toBeNull();

    const clearedCookies = res.headers["set-cookie"] as unknown as string[];
    const refreshCookie = clearedCookies.find((c) => c.startsWith("refresh_token="))!;
    expect(refreshCookie).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("a refresh attempt after logout fails (cookies cleared)", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    await request(app)
      .post("/auth/logout")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);

    // Client-side, the browser would have dropped the cookies already; simulate a client
    // that still (incorrectly) tries to reuse the pre-logout values -- must still fail
    // because the session itself is revoked server-side, independent of cookie clearing.
    const res = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);
    expect(res.status).toBe(401);
  });
});
