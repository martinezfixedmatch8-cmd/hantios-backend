import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";
import { loginAndGetCookies } from "./helpers/cookies";

// Batch 2 remediation (HNT2-AUTH-001 + HNT-AUTH-004) -- real-time
// session_version/status revocation, checked on every authenticated
// request via authenticate.ts, plus the refresh-level idle timeout.
//
// GET /branches (owner/manager, authenticate-gated) stands in as the
// generic "any protected route" probe throughout -- nothing about this
// batch's fix is route-specific, so one representative route is sufficient
// to prove the middleware-level guarantee.
//
// Two of the finding's own named trigger scenarios -- deactivation and
// role downgrade -- have no real API endpoint to exercise through in this
// repo yet (confirmed via a direct grep of src/routes, src/controllers,
// src/services before writing this file: only invite/accept-invite exist
// under /staff, per CLAUDE.md's own long-standing "Staff module is
// incomplete" note). Both are tested here via a direct prisma.users.update
// simulating exactly what a future deactivate/role-change endpoint would
// eventually do to session_version/status -- this is testing the
// AUTHENTICATION MIDDLEWARE's own reaction to that state change, which is
// what this batch actually builds; it is not a substitute for those
// endpoints themselves, which remain deliberately out of scope here.
describe("Session revocation: real-time session_version/status checks (HNT2-AUTH-001) + idle timeout (HNT-AUTH-004)", () => {
  const businessIds: string[] = [];

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  async function login(email: string, password: string, deviceId: string) {
    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", deviceId)
      .send({ email, password });
    expect(res.status).toBe(200);
    return {
      accessToken: res.body.data.accessToken as string,
      cookies: res.headers["set-cookie"] as unknown as string[],
    };
  }

  it("a token minted before a session_version bump is denied on the very next request", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { accessToken } = await login(owner.email, owner.password, "d1");

    const before = await request(app).get("/branches").set("Authorization", `Bearer ${accessToken}`);
    expect(before.status).toBe(200);

    // Simulates what a future role-change/logout-all-style action would do:
    // bump session_version without necessarily deactivating the account.
    await prisma.users.update({ where: { id: owner.ownerId }, data: { session_version: { increment: 1 } } });

    const after = await request(app).get("/branches").set("Authorization", `Bearer ${accessToken}`);
    expect(after.status).toBe(401);
  });

  it("a deactivated account's already-issued token is denied on the very next request", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { accessToken } = await login(owner.email, owner.password, "d1");

    // Simulates a future deactivate endpoint: status flips away from
    // active. (No session_version bump needed for THIS assertion --
    // status alone is checked independently.)
    await prisma.users.update({ where: { id: owner.ownerId }, data: { status: "archived" } });

    const res = await request(app).get("/branches").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });

  it("a deactivated account cannot obtain a NEW token via login either", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    await prisma.users.update({ where: { id: owner.ownerId }, data: { status: "archived" } });

    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "d1")
      .send({ email: owner.email, password: owner.password });
    expect(res.status).toBe(403);
  });

  it("refresh() also denies a deactivated account, even with an otherwise-valid, unexpired refresh cookie", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    await prisma.users.update({ where: { id: owner.ownerId }, data: { status: "archived" } });

    const res = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);
    expect(res.status).toBe(401);
  });

  it("role-change simulation: an old token's stale role claim stops working once session_version is bumped alongside it", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { accessToken: staleToken } = await login(owner.email, owner.password, "d1");

    // Simulates a future role-change endpoint downgrading the account and
    // bumping session_version in the same action (per this batch's own
    // locked design -- role change is one of the named session_version
    // bump triggers).
    await prisma.users.update({
      where: { id: owner.ownerId },
      data: { role: "cashier", session_version: { increment: 1 } },
    });

    const res = await request(app).get("/branches").set("Authorization", `Bearer ${staleToken}`);
    // Denied outright -- not "let through with the old, now-wrong role
    // claim." A fresh login now mints a token carrying the real, current
    // role and session_version.
    expect(res.status).toBe(401);

    const relogin = await login(owner.email, owner.password, "d1");
    const fresh = await request(app).get("/branches").set("Authorization", `Bearer ${relogin.accessToken}`);
    // cashier is not owner/manager -- correctly forbidden by requireRole,
    // proving the FRESH token really does carry the new, current role.
    expect(fresh.status).toBe(403);
  });

  it("logout-all revokes every session and denies the very next request on the same token", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { accessToken } = await login(owner.email, owner.password, "d1");
    const other = await login(owner.email, owner.password, "d2");

    const logoutAllRes = await request(app).post("/auth/logout-all").set("Authorization", `Bearer ${accessToken}`);
    expect(logoutAllRes.status).toBe(200);

    const afterLogout = await request(app).get("/branches").set("Authorization", `Bearer ${accessToken}`);
    expect(afterLogout.status).toBe(401);
    const afterLogoutOtherDevice = await request(app).get("/branches").set("Authorization", `Bearer ${other.accessToken}`);
    expect(afterLogoutOtherDevice.status).toBe(401);

    const sessions = await prisma.sessions.findMany({ where: { user_id: owner.ownerId } });
    expect(sessions.every((s) => s.revoked_at !== null)).toBe(true);
  });

  it("logout-all requires authentication", async () => {
    const res = await request(app).post("/auth/logout-all");
    expect(res.status).toBe(401);
  });

  it("super_admin is denied the same way as any other role once revoked -- authentication validity is uniform, not bypassed by the requireRole super_admin rule", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    await prisma.users.update({ where: { id: owner.ownerId }, data: { role: "super_admin" } });
    const { accessToken } = await login(owner.email, owner.password, "d1");

    const before = await request(app).get("/branches").set("Authorization", `Bearer ${accessToken}`);
    expect(before.status).toBe(200);

    await prisma.users.update({ where: { id: owner.ownerId }, data: { session_version: { increment: 1 } } });

    const after = await request(app).get("/branches").set("Authorization", `Bearer ${accessToken}`);
    expect(after.status).toBe(401);
  });

  it("a session idle for more than 30 minutes is rejected on refresh and revoked", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "idle-device");

    await prisma.sessions.updateMany({
      where: { user_id: owner.ownerId, device_id: "idle-device" },
      data: { last_active_at: new Date(Date.now() - (30 * 60 * 1000 + 1000)) },
    });

    const res = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);
    expect(res.status).toBe(401);

    // signupTestOwner's own signup call already issued a first session on a
    // different device -- scope this lookup to the exact device under test,
    // not just any session belonging to this user.
    const session = await prisma.sessions.findFirstOrThrow({
      where: { user_id: owner.ownerId, device_id: "idle-device" },
    });
    expect(session.revoked_at).not.toBeNull();
  });

  it("a session refreshed within the 30-minute window stays valid", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "active-device");

    await prisma.sessions.updateMany({
      where: { user_id: owner.ownerId, device_id: "active-device" },
      data: { last_active_at: new Date(Date.now() - 29 * 60 * 1000) },
    });

    const res = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
  });
});
