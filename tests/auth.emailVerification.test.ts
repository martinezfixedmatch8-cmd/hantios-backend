import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";
import { SpyNotificationProvider } from "./helpers/notificationSpy";
import { setNotificationProvider } from "../src/notifications/registry";
import { hashToken } from "../src/lib/tokens";

// Batch 2 remediation (HNT-AUTH-005, extended scope) -- email_verification_token
// is now hashed at rest (email_verification_token_hash); the raw token is
// only ever observable at the moment it's emailed, never recoverable from
// the DB afterward. Every test here installs a spy before signup and
// extracts the real, emailed raw token from the captured notification body,
// rather than reading it back off the user row.
function extractVerifyToken(body: string): string {
  const match = body.match(/\/verify-email\/([a-f0-9]{64})/);
  if (!match) throw new Error(`No verification token found in email body: ${body}`);
  return match[1];
}

describe("Email verification", () => {
  const businessIds: string[] = [];
  let spy: SpyNotificationProvider;

  beforeEach(() => {
    spy = new SpyNotificationProvider();
    setNotificationProvider(spy);
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  it("sends a verification token on signup, unverified until used", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);

    const emailSend = spy.sent.find((n) => n.channel === "email");
    expect(emailSend).toBeTruthy();
    expect(extractVerifyToken(emailSend!.body)).toHaveLength(64);

    const user = await prisma.users.findUnique({ where: { id: owner.ownerId } });
    expect(user?.email_verification_token_hash).toBeTruthy();
    expect(user?.email_verification_expires_at).not.toBeNull();
    expect(user?.email_verified_at).toBeNull();
    // The hash stored is the hash of exactly the token that was emailed --
    // proving the DB never holds a recoverable copy of the raw value.
    expect(user?.email_verification_token_hash).toBe(hashToken(extractVerifyToken(emailSend!.body)));
  });

  it("verifies a valid token and clears it (single use)", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const emailSend = spy.sent.find((n) => n.channel === "email");
    const token = extractVerifyToken(emailSend!.body);

    const res = await request(app).get(`/auth/verify-email/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(owner.ownerId);

    const updated = await prisma.users.findUnique({ where: { id: owner.ownerId } });
    expect(updated?.email_verified_at).not.toBeNull();
    expect(updated?.email_verification_token_hash).toBeNull();
    expect(updated?.email_verification_expires_at).toBeNull();
  });

  it("returns 400 for an unknown token", async () => {
    const res = await request(app).get("/auth/verify-email/does-not-exist");
    expect(res.status).toBe(400);
  });

  it("returns 410 for an expired token", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    await prisma.users.update({
      where: { id: owner.ownerId },
      data: { email_verification_expires_at: new Date(Date.now() - 1000) },
    });
    const emailSend = spy.sent.find((n) => n.channel === "email");
    const token = extractVerifyToken(emailSend!.body);

    const res = await request(app).get(`/auth/verify-email/${token}`);
    expect(res.status).toBe(410);
  });

  it("returns 400 when the same link is used a second time", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const emailSend = spy.sent.find((n) => n.channel === "email");
    const token = extractVerifyToken(emailSend!.body);

    const first = await request(app).get(`/auth/verify-email/${token}`);
    expect(first.status).toBe(200);

    const second = await request(app).get(`/auth/verify-email/${token}`);
    expect(second.status).toBe(400);
  });
});
