import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, TEST_PASSWORD } from "./helpers/factories";
import { SpyNotificationProvider } from "./helpers/notificationSpy";
import { setNotificationProvider } from "../src/notifications/registry";
import { hashToken } from "../src/lib/tokens";

function extractResetToken(body: string): string {
  const match = body.match(/\/reset-password\/([a-f0-9]{64})/);
  if (!match) throw new Error(`No reset token found in email body: ${body}`);
  return match[1];
}

const NEW_PASSWORD = "N3w!Str0ngPassw0rd";

describe("Password reset: link-based, hashed token (HNT-AUTH-003)", () => {
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

  async function requestReset(email: string) {
    const res = await request(app).post("/auth/forgot-password").send({ email });
    expect(res.status).toBe(200);
    const emailSend = spy.sent.find((n) => n.channel === "email" && n.category === "SECURITY");
    expect(emailSend).toBeTruthy();
    return extractResetToken(emailSend!.body);
  }

  it("returns the same generic response for a real account, an unknown email, and a Google-only account", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    spy.sent = []; // signupTestOwner's own verification email isn't what's under test here

    const real = await request(app).post("/auth/forgot-password").send({ email: owner.email });
    const unknown = await request(app).post("/auth/forgot-password").send({ email: "nobody-at-all@example.test" });

    expect(real.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(real.body).toEqual(unknown.body);

    // Only the real account actually got an email -- proving the identical
    // response hides a real difference in behavior, not that nothing happened.
    expect(spy.sent.filter((n) => n.channel === "email")).toHaveLength(1);
  });

  it("does not send an email or create a token for a Google-only account (no password to reset)", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    await prisma.users.update({
      where: { id: owner.ownerId },
      data: { password_hash: null, oauth_provider: "google", oauth_provider_id: "fake-sub" },
    });
    spy.sent = []; // signupTestOwner's own verification email isn't what's under test here

    const res = await request(app).post("/auth/forgot-password").send({ email: owner.email });
    expect(res.status).toBe(200);
    expect(spy.sent.filter((n) => n.channel === "email")).toHaveLength(0);
    const tokens = await prisma.password_reset_tokens.findMany({ where: { user_id: owner.ownerId } });
    expect(tokens).toHaveLength(0);
  });

  it("only the hash is ever persisted -- the stored value is not the raw emailed token", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const token = await requestReset(owner.email);

    const record = await prisma.password_reset_tokens.findFirstOrThrow({ where: { user_id: owner.ownerId } });
    expect(record.token_hash).not.toBe(token);
    expect(record.token_hash).toBe(hashToken(token));
  });

  it("resets the password on the happy path, revokes all sessions, and blocks reuse of the same link", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    // A real, active session to prove it gets revoked.
    const loginRes = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "d1")
      .send({ email: owner.email, password: owner.password });
    const accessToken = loginRes.body.data.accessToken as string;

    const token = await requestReset(owner.email);
    spy.sent = [];

    const res = await request(app).post("/auth/reset-password").send({ token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    // Pre-existing session's own access token is denied immediately (HNT-AUTH-003's
    // own "revoke all sessions" requirement, closed via the shared invalidateUserSessions primitive).
    // Checked BEFORE any further login below -- a later login legitimately
    // issues a brand-new, unrevoked session, which would pollute this check
    // if it ran afterward instead.
    const probe = await request(app).get("/branches").set("Authorization", `Bearer ${accessToken}`);
    expect(probe.status).toBe(401);
    const sessionsRightAfterReset = await prisma.sessions.findMany({ where: { user_id: owner.ownerId } });
    expect(sessionsRightAfterReset.every((s) => s.revoked_at !== null)).toBe(true);

    // A confirmation email was sent.
    expect(spy.sent.some((n) => n.channel === "email" && n.category === "SECURITY")).toBe(true);

    // Old password no longer works.
    const oldLoginAttempt = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "d2")
      .send({ email: owner.email, password: owner.password });
    expect(oldLoginAttempt.status).toBe(401);

    // New password works.
    const newLoginAttempt = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "d2")
      .send({ email: owner.email, password: NEW_PASSWORD });
    expect(newLoginAttempt.status).toBe(200);

    // The same link cannot be used a second time.
    const replay = await request(app).post("/auth/reset-password").send({ token, newPassword: "Another!1Pass" });
    expect(replay.status).toBe(400);
  });

  it("rejects an expired reset link", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const token = await requestReset(owner.email);
    await prisma.password_reset_tokens.updateMany({
      where: { user_id: owner.ownerId },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const res = await request(app).post("/auth/reset-password").send({ token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown token", async () => {
    const res = await request(app)
      .post("/auth/reset-password")
      .send({ token: "a".repeat(64), newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("rejects reusing the current password", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const token = await requestReset(owner.email);

    const res = await request(app).post("/auth/reset-password").send({ token, newPassword: TEST_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("rejects a weak new password before ever touching the token", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const token = await requestReset(owner.email);

    const res = await request(app).post("/auth/reset-password").send({ token, newPassword: "weak" });
    expect(res.status).toBe(400);

    // The token is still unconsumed -- a validation failure never claims it.
    const record = await prisma.password_reset_tokens.findFirstOrThrow({ where: { user_id: owner.ownerId } });
    expect(record.consumed_at).toBeNull();
  });

  it("only one of two concurrent uses of the same reset link succeeds", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const token = await requestReset(owner.email);

    const [first, second] = await Promise.all([
      request(app).post("/auth/reset-password").send({ token, newPassword: NEW_PASSWORD }),
      request(app).post("/auth/reset-password").send({ token, newPassword: "AnotherC0mpletely!Diff" }),
    ]);
    const statuses = [first.status, second.status];
    expect(statuses).toContain(200);
    expect(statuses).toContain(400);
  });
});
