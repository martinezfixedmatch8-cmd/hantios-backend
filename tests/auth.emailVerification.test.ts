import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";

describe("Email verification", () => {
  const businessIds: string[] = [];

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  it("sends a verification token on signup, unverified until used", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);

    const user = await prisma.users.findUnique({ where: { id: owner.ownerId } });
    expect(user?.email_verification_token).toBeTruthy();
    expect(user?.email_verification_expires_at).not.toBeNull();
    expect(user?.email_verified_at).toBeNull();
  });

  it("verifies a valid token and clears it (single use)", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const user = await prisma.users.findUnique({ where: { id: owner.ownerId } });

    const res = await request(app).get(`/auth/verify-email/${user!.email_verification_token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(owner.ownerId);

    const updated = await prisma.users.findUnique({ where: { id: owner.ownerId } });
    expect(updated?.email_verified_at).not.toBeNull();
    expect(updated?.email_verification_token).toBeNull();
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
    const user = await prisma.users.findUnique({ where: { id: owner.ownerId } });

    const res = await request(app).get(`/auth/verify-email/${user!.email_verification_token}`);
    expect(res.status).toBe(410);
  });

  it("returns 400 when the same link is used a second time", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const user = await prisma.users.findUnique({ where: { id: owner.ownerId } });
    const token = user!.email_verification_token!;

    const first = await request(app).get(`/auth/verify-email/${token}`);
    expect(first.status).toBe(200);

    const second = await request(app).get(`/auth/verify-email/${token}`);
    expect(second.status).toBe(400);
  });
});
