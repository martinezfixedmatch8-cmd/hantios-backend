import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { setGoogleAuthProvider, getGoogleAuthProvider } from "../src/lib/googleAuth";
import { FakeGoogleAuthProvider } from "./helpers/fakeGoogleAuth";

function googlePayload(idToken: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: "google",
    idToken,
    businessName: `Google Signup Biz ${randomUUID()}`,
    phone: "+254712345678",
    country: "KE",
    termsAccepted: true,
    privacyAccepted: true,
    ...overrides,
  };
}

describe("POST /auth/signup (google path)", () => {
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

  it("creates a business + owner via a verified Google identity, email verified immediately", async () => {
    const idToken = `fake-${randomUUID()}`;
    const identity = fakeProvider.registerIdentity(idToken, { emailVerified: true, name: "Google Owner" });

    const res = await request(app).post("/auth/signup").set("X-Device-Id", "d1").send(googlePayload(idToken));

    expect(res.status).toBe(201);
    businessIds.push(res.body.data.business.id);
    expect(res.body.data.user.email).toBe(identity.email);

    const user = await prisma.users.findUnique({ where: { id: res.body.data.user.id } });
    expect(user?.password_hash).toBeNull();
    expect(user?.oauth_provider).toBe("google");
    expect(user?.oauth_provider_id).toBe(identity.sub);
    expect(user?.email_verified_at).not.toBeNull();

    const history = await prisma.password_history.findMany({ where: { user_id: user!.id } });
    expect(history).toHaveLength(0);
  });

  it("uses the Google identity's name when ownerFullName is not provided", async () => {
    const idToken = `fake-${randomUUID()}`;
    const identity = fakeProvider.registerIdentity(idToken, { name: "Auto Named Owner" });

    const res = await request(app).post("/auth/signup").set("X-Device-Id", "d1").send(googlePayload(idToken));

    expect(res.status).toBe(201);
    businessIds.push(res.body.data.business.id);
    expect(res.body.data.user.name).toBe(identity.name);
  });

  it("respects an explicit ownerFullName override", async () => {
    const idToken = `fake-${randomUUID()}`;
    fakeProvider.registerIdentity(idToken, { name: "Google Default Name" });

    const res = await request(app)
      .post("/auth/signup")
      .set("X-Device-Id", "d1")
      .send(googlePayload(idToken, { ownerFullName: "Custom Display Name" }));

    expect(res.status).toBe(201);
    businessIds.push(res.body.data.business.id);
    expect(res.body.data.user.name).toBe("Custom Display Name");
  });

  it("returns 401 for an unregistered/invalid idToken", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .set("X-Device-Id", "d1")
      .send(googlePayload("not-a-real-token"));
    expect(res.status).toBe(401);
  });

  it("returns 409 when the Google email already has an account", async () => {
    const idToken = `fake-${randomUUID()}`;
    const identity = fakeProvider.registerIdentity(idToken);

    const first = await request(app).post("/auth/signup").set("X-Device-Id", "d1").send(googlePayload(idToken));
    expect(first.status).toBe(201);
    businessIds.push(first.body.data.business.id);

    const idToken2 = `fake-${randomUUID()}`;
    fakeProvider.registerIdentity(idToken2, { email: identity.email });
    const second = await request(app).post("/auth/signup").set("X-Device-Id", "d2").send(googlePayload(idToken2));
    expect(second.status).toBe(409);
  });
});
