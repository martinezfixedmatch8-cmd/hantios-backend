import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";
import { loginAndGetCookies } from "./helpers/cookies";

describe("CSRF double-submit enforcement (requireCsrf)", () => {
  const businessIds: string[] = [];

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  it("rejects when both the cookie and header are missing", async () => {
    const res = await request(app).post("/auth/refresh");
    expect(res.status).toBe(403);
  });

  it("rejects when the csrf cookie is present but the header is missing (cookie-only)", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    const res = await request(app).post("/auth/refresh").set("Cookie", [refresh.header, csrf.header]);
    expect(res.status).toBe(403);
  });

  it("rejects when the header is present but the csrf cookie is missing (header-only)", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    const res = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header]) // csrf cookie deliberately omitted
      .set("X-CSRF-Token", csrf.value);
    expect(res.status).toBe(403);
  });

  it("rejects when cookie and header are both present but don't match", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    const res = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value + "-tampered");
    expect(res.status).toBe(403);
  });

  it("accepts when cookie and header match exactly", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const { refresh, csrf } = await loginAndGetCookies(owner.email, owner.password, "d1");

    const res = await request(app)
      .post("/auth/refresh")
      .set("Cookie", [refresh.header, csrf.header])
      .set("X-CSRF-Token", csrf.value);
    expect(res.status).toBe(200);
  });
});
