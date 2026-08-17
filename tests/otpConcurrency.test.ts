import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";
import { SpyNotificationProvider } from "./helpers/notificationSpy";
import { setNotificationProvider } from "../src/notifications/registry";

// Batch 2 remediation (HNT-AUTH-001 + HNT-AUTH-002) -- verifyOtpChallenge's
// atomic-claim fix and purpose-scoping, exercised through the two real
// endpoints that call it (signup phone verification, device-login OTP).
describe("OTP challenge: atomic claim + purpose scoping (HNT-AUTH-001/002)", () => {
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

  async function signupAndGetPhoneChallenge() {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const challenge = await prisma.otp_challenges.findFirstOrThrow({
      where: { user_id: owner.ownerId, purpose: "signup" },
    });
    const code = spy.sent.find((n) => n.channel === "whatsapp")!.body.match(/code is (\d{6})/)![1];
    return { owner, challengeId: challenge.id, code };
  }

  it("only lets one of two concurrent valid verifies succeed", async () => {
    const { challengeId, code } = await signupAndGetPhoneChallenge();

    const [first, second] = await Promise.all([
      request(app).post("/auth/signup/verify-phone-otp").send({ challengeId, code }),
      request(app).post("/auth/signup/verify-phone-otp").send({ challengeId, code }),
    ]);

    const statuses = [first.status, second.status];
    expect(statuses).toContain(200);
    // The loser sees "already used" (410, gone) -- the claim already
    // succeeded for the other request by the time this one's own atomic
    // updateMany runs, so it correctly reads as consumed, not incorrect.
    expect(statuses).toContain(410);

    const challenge = await prisma.otp_challenges.findUniqueOrThrow({ where: { id: challengeId } });
    expect(challenge.consumed_at).not.toBeNull();
  });

  it("a signup-purpose challenge is rejected at the device-login-OTP endpoint", async () => {
    const { challengeId, code } = await signupAndGetPhoneChallenge();

    const res = await request(app)
      .post("/auth/login/verify-device-otp")
      .set("X-Device-Id", "cross-purpose-device")
      .send({ challengeId, code });
    expect(res.status).toBe(400);

    // Confirm it's genuinely still unconsumed -- the rejection was a clean
    // purpose mismatch, not an accidental partial consume.
    const challenge = await prisma.otp_challenges.findUniqueOrThrow({ where: { id: challengeId } });
    expect(challenge.consumed_at).toBeNull();

    // And the real, same-purpose endpoint still accepts it afterward.
    const realRes = await request(app).post("/auth/signup/verify-phone-otp").send({ challengeId, code });
    expect(realRes.status).toBe(200);
  });

  it("a device-login-purpose challenge is rejected at the signup-phone-OTP endpoint", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    await prisma.businesses.update({
      where: { id: owner.businessId },
      data: { settings: { security: { requireOtpForNewDevices: true } } },
    });
    spy.sent = [];

    const loginRes = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "brand-new-device")
      .send({ email: owner.email, password: owner.password });
    expect(loginRes.body.data.requiresOtp).toBe(true);
    const challengeId = loginRes.body.data.challengeId as string;
    const code = spy.sent[0].body.match(/code is (\d{6})/)![1];

    const res = await request(app).post("/auth/signup/verify-phone-otp").send({ challengeId, code });
    expect(res.status).toBe(400);
  });

  it("an expired challenge is never claimable even under concurrency", async () => {
    const { challengeId, code } = await signupAndGetPhoneChallenge();
    await prisma.otp_challenges.update({ where: { id: challengeId }, data: { expires_at: new Date(Date.now() - 1000) } });

    const [first, second] = await Promise.all([
      request(app).post("/auth/signup/verify-phone-otp").send({ challengeId, code }),
      request(app).post("/auth/signup/verify-phone-otp").send({ challengeId, code }),
    ]);
    expect(first.status).toBe(410);
    expect(second.status).toBe(410);

    const challenge = await prisma.otp_challenges.findUniqueOrThrow({ where: { id: challengeId } });
    expect(challenge.consumed_at).toBeNull();
  });

  it("a max-attempts-exhausted challenge is never claimable even with the correct code", async () => {
    const { challengeId, code } = await signupAndGetPhoneChallenge();
    await prisma.otp_challenges.update({ where: { id: challengeId }, data: { attempts: 5 } });

    const res = await request(app).post("/auth/signup/verify-phone-otp").send({ challengeId, code });
    expect(res.status).toBe(410);
  });
});
