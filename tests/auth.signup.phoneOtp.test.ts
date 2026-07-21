import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";
import { SpyNotificationProvider } from "./helpers/notificationSpy";
import { setNotificationProvider } from "../src/notifications/registry";

describe("POST /auth/signup/verify-phone-otp", () => {
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

  async function signupAndGetChallenge() {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const challenge = await prisma.otp_challenges.findFirstOrThrow({
      where: { user_id: owner.ownerId, purpose: "signup" },
    });
    const code = spy.sent.find((n) => n.channel === "whatsapp")!.body.match(/code is (\d{6})/)![1];
    return { owner, challengeId: challenge.id, code };
  }

  it("does not block signup or login -- phone stays unverified until this endpoint is called", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const user = await prisma.users.findUnique({ where: { id: owner.ownerId } });
    expect(user?.phone_verified_at).toBeNull();

    const loginRes = await request(app)
      .post("/auth/login")
      .set("X-Device-Id", "d1")
      .send({ email: owner.email, password: owner.password });
    expect(loginRes.status).toBe(200);
  });

  it("sets phone_verified_at on the correct code", async () => {
    const { owner, challengeId, code } = await signupAndGetChallenge();

    const res = await request(app).post("/auth/signup/verify-phone-otp").send({ challengeId, code });
    expect(res.status).toBe(200);

    const user = await prisma.users.findUnique({ where: { id: owner.ownerId } });
    expect(user?.phone_verified_at).not.toBeNull();
  });

  it("rejects a wrong code", async () => {
    const { challengeId } = await signupAndGetChallenge();
    const res = await request(app)
      .post("/auth/signup/verify-phone-otp")
      .send({ challengeId, code: "000000" });
    expect(res.status).toBe(400);
  });
});
