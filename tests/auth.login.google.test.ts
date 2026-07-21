import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { setGoogleAuthProvider, getGoogleAuthProvider } from "../src/lib/googleAuth";
import { FakeGoogleAuthProvider } from "./helpers/fakeGoogleAuth";
import { signupTestOwner } from "./helpers/factories";

describe("POST /auth/google/login and /auth/google/identify", () => {
  const businessIds: string[] = [];
  const originalProvider = getGoogleAuthProvider();
  let fakeProvider: FakeGoogleAuthProvider;

  beforeEach(() => {
    fakeProvider = new FakeGoogleAuthProvider();
    setGoogleAuthProvider(fakeProvider);
  });

  afterAll(async () => {
    setGoogleAuthProvider(originalProvider);
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  async function signupViaGoogle() {
    const idToken = `fake-${randomUUID()}`;
    fakeProvider.registerIdentity(idToken);
    const res = await request(app)
      .post("/auth/signup")
      .set("X-Device-Id", "d1")
      .send({
        provider: "google",
        idToken,
        businessName: `Google Login Biz ${randomUUID()}`,
        phone: "+254712345678",
        country: "KE",
        termsAccepted: true,
        privacyAccepted: true,
      });
    businessIds.push(res.body.data.business.id);
    return { idToken, email: res.body.data.user.email as string, userId: res.body.data.user.id as string };
  }

  describe("google/identify", () => {
    it("reports exists=false for an unknown identity", async () => {
      const idToken = `fake-${randomUUID()}`;
      fakeProvider.registerIdentity(idToken);
      const res = await request(app).post("/auth/google/identify").send({ idToken });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ exists: false, hasPasswordAccount: false });
    });

    it("reports exists=true, hasPasswordAccount=true for an email-signup account", async () => {
      const owner = await signupTestOwner();
      businessIds.push(owner.businessId);
      const idToken = `fake-${randomUUID()}`;
      fakeProvider.registerIdentity(idToken, { email: owner.email });

      const res = await request(app).post("/auth/google/identify").send({ idToken });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ exists: true, hasPasswordAccount: true });
    });
  });

  describe("google/login", () => {
    it("logs in an existing Google-linked account", async () => {
      const { idToken } = await signupViaGoogle();

      const res = await request(app).post("/auth/google/login").set("X-Device-Id", "d1").send({ idToken });
      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeTruthy();

      const setCookie = res.headers["set-cookie"] as unknown as string[];
      expect(setCookie.some((c) => c.startsWith("refresh_token="))).toBe(true);
    });

    it("returns 404 for an identity with no account", async () => {
      const idToken = `fake-${randomUUID()}`;
      fakeProvider.registerIdentity(idToken);
      const res = await request(app).post("/auth/google/login").set("X-Device-Id", "d1").send({ idToken });
      expect(res.status).toBe(404);
    });

    it("returns 409 when the email belongs to an existing password-only account", async () => {
      const owner = await signupTestOwner();
      businessIds.push(owner.businessId);
      const idToken = `fake-${randomUUID()}`;
      fakeProvider.registerIdentity(idToken, { email: owner.email });

      const res = await request(app).post("/auth/google/login").set("X-Device-Id", "d1").send({ idToken });
      expect(res.status).toBe(409);
    });
  });
});
