import request from "supertest";
import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken } from "./helpers/factories";

describe("Tags", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  it("returns 401 with no token", async () => {
    const res = await request(app).get("/tags");
    expect(res.status).toBe(401);
  });

  it("lets owner/manager create a tag", async () => {
    const res = await request(app).post("/tags").set("Authorization", `Bearer ${ownerToken}`).send({ name: `Travel ${randomUUID()}` });
    expect(res.status).toBe(201);
    expect(res.body.data.business_id).toBe(businessId);

    const auditRows = await prisma.audit_logs.findMany({ where: { action: "tag.created", entity_id: res.body.data.id } });
    expect(auditRows).toHaveLength(1);
  });

  it("returns 400 for a duplicate tag name within the same business", async () => {
    const name = `Duplicate ${randomUUID()}`;
    const first = await request(app).post("/tags").set("Authorization", `Bearer ${ownerToken}`).send({ name });
    expect(first.status).toBe(201);

    const second = await request(app).post("/tags").set("Authorization", `Bearer ${ownerToken}`).send({ name });
    expect(second.status).toBe(400);
  });

  it("returns a {data, pagination} envelope on list", async () => {
    await request(app).post("/tags").set("Authorization", `Bearer ${ownerToken}`).send({ name: `Listed ${randomUUID()}` });
    const res = await request(app).get("/tags?pageSize=1").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("pagination");
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });

  it("scopes tags per business -- a second business starts with none of the first business's tags", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);

    const uniqueName = `OnlyInFirstBusiness ${randomUUID()}`;
    await request(app).post("/tags").set("Authorization", `Bearer ${ownerToken}`).send({ name: uniqueName });

    const res = await request(app).get(`/tags?search=${encodeURIComponent(uniqueName)}`).set("Authorization", `Bearer ${otherLogin.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  describe("full permission matrix", () => {
    const deniedCreate: UserRole[] = ["accountant", "cashier", "storekeeper", "shareholder", "custom"];
    const deniedRead: UserRole[] = ["cashier", "storekeeper", "shareholder", "custom"];

    it.each(deniedCreate)("denies role=%s creating a tag", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).post("/tags").set("Authorization", `Bearer ${token}`).send({ name: `Denied ${randomUUID()}` });
      expect(res.status).toBe(403);
    });

    it.each(deniedRead)("denies role=%s listing tags", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).get("/tags").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("allows manager to create and accountant to list but not create", async () => {
      const manager = await createTestUser(businessId, "manager");
      const managerToken = mintAccessToken(manager);
      const createRes = await request(app).post("/tags").set("Authorization", `Bearer ${managerToken}`).send({ name: `Manager Tag ${randomUUID()}` });
      expect(createRes.status).toBe(201);

      const accountant = await createTestUser(businessId, "accountant");
      const accountantToken = mintAccessToken(accountant);
      const listRes = await request(app).get("/tags").set("Authorization", `Bearer ${accountantToken}`);
      expect(listRes.status).toBe(200);
      const accountantCreateRes = await request(app).post("/tags").set("Authorization", `Bearer ${accountantToken}`).send({ name: `x ${randomUUID()}` });
      expect(accountantCreateRes.status).toBe(403);
    });

    it("allows super_admin to create and list regardless of role restrictions", async () => {
      const admin = await createTestUser(businessId, "super_admin");
      const token = mintAccessToken(admin);
      const createRes = await request(app).post("/tags").set("Authorization", `Bearer ${token}`).send({ name: `Admin Tag ${randomUUID()}` });
      expect(createRes.status).toBe(201);
      const listRes = await request(app).get("/tags").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(200);
    });
  });
});
