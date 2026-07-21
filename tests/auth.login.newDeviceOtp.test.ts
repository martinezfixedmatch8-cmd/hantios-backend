import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";
import { SpyNotificationProvider } from "./helpers/notificationSpy";
import { setNotificationProvider } from "../src/notifications/registry";

async function enableNewDeviceOtp(businessId: string) {
  await prisma.businesses.update({
    where: { id: businessId },
    data: { settings: { security: { requireOtpForNewDevices: true } } },
  });
}

describe("New Device / High-Risk Login OTP toggle", () => {
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

  it("never challenges when the toggle is OFF (default), even for a brand-new device", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);

    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "never-seen-device")
      .send({ email: owner.email, password: owner.password });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it("does not challenge a device that already has a session, even with the toggle ON", async () => {
    const owner = await signupTestOwner({ deviceId: "known-device" });
    businessIds.push(owner.businessId);
    await enableNewDeviceOtp(owner.businessId);

    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "known-device")
      .send({ email: owner.email, password: owner.password });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it("re-challenges a device once its only session has been revoked (trust doesn't persist past logout)", async () => {
    const owner = await signupTestOwner({ deviceId: "logged-out-device" });
    businessIds.push(owner.businessId);
    await enableNewDeviceOtp(owner.businessId);

    await prisma.sessions.updateMany({
      where: { user_id: owner.ownerId, device_id: "logged-out-device" },
      data: { revoked_at: new Date() },
    });

    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "logged-out-device")
      .send({ email: owner.email, password: owner.password });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ requiresOtp: true });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("re-challenges a device once its only session has expired", async () => {
    const owner = await signupTestOwner({ deviceId: "stale-device" });
    businessIds.push(owner.businessId);
    await enableNewDeviceOtp(owner.businessId);

    await prisma.sessions.updateMany({
      where: { user_id: owner.ownerId, device_id: "stale-device" },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "stale-device")
      .send({ email: owner.email, password: owner.password });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ requiresOtp: true });
  });

  it("challenges a brand-new device when the toggle is ON, and does not issue a session yet", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    await enableNewDeviceOtp(owner.businessId);
    spy.sent = []; // signupTestOwner's own phone/email notifications aren't what's under test here

    const res = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "new-device")
      .send({ email: owner.email, password: owner.password });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ requiresOtp: true });
    expect(res.body.data.challengeId).toBeTruthy();
    expect(res.headers["set-cookie"]).toBeUndefined();

    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0]).toMatchObject({ category: "SECURITY", channel: "whatsapp" });
  });

  it("rejects a wrong OTP code and does not issue a session", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    await enableNewDeviceOtp(owner.businessId);

    const challenge = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "new-device")
      .send({ email: owner.email, password: owner.password });

    const res = await request(app)
      .post("/auth/login/verify-device-otp")
      .set("X-Device-Id", "new-device")
      .send({ challengeId: challenge.body.data.challengeId, code: "000000" });
    expect(res.status).toBe(400);
  });

  it("rejects an expired OTP challenge", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    await enableNewDeviceOtp(owner.businessId);
    spy.sent = []; // isolate the notification the code is extracted from, below

    const challenge = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "new-device")
      .send({ email: owner.email, password: owner.password });

    await prisma.otp_challenges.update({
      where: { id: challenge.body.data.challengeId },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    // Extract the real code from the notification body to prove it's the *expiry* that
    // rejects it, not the code itself.
    const code = spy.sent[0].body.match(/code is (\d{6})/)?.[1];
    const res = await request(app)
      .post("/auth/login/verify-device-otp")
      .set("X-Device-Id", "new-device")
      .send({ challengeId: challenge.body.data.challengeId, code });
    expect(res.status).toBe(410);
  });

  it("locks out after max_attempts wrong codes", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    await enableNewDeviceOtp(owner.businessId);

    const challenge = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "new-device")
      .send({ email: owner.email, password: owner.password });
    const challengeId = challenge.body.data.challengeId;

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/auth/login/verify-device-otp")
        .set("X-Device-Id", "new-device")
        .send({ challengeId, code: "000000" });
    }

    const res = await request(app)
      .post("/auth/login/verify-device-otp")
      .set("X-Device-Id", "new-device")
      .send({ challengeId, code: "000000" });
    expect(res.status).toBe(410);
  });

  it("completes login with the correct code, and the device becomes known afterward", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    await enableNewDeviceOtp(owner.businessId);
    spy.sent = []; // isolate the notification the code is extracted from, below

    const challenge = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "new-device")
      .send({ email: owner.email, password: owner.password });
    const code = spy.sent[0].body.match(/code is (\d{6})/)?.[1];

    const verifyRes = await request(app)
      .post("/auth/login/verify-device-otp")
      .set("X-Device-Id", "new-device")
      .send({ challengeId: challenge.body.data.challengeId, code });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.accessToken).toBeTruthy();
    const setCookie = verifyRes.headers["set-cookie"] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith("refresh_token="))).toBe(true);

    const secondLogin = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "new-device")
      .send({ email: owner.email, password: owner.password });
    expect(secondLogin.status).toBe(200);
    expect(secondLogin.body.data.accessToken).toBeTruthy();
  });
});
