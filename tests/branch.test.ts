import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestBranch } from "./helpers/factories";

describe("Branches", () => {
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

  const validPayload = () => ({ name: `Downtown Branch ${randomUUID()}`, location: "Main St" });

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/branches").send(validPayload());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a cashier (not owner/manager)", async () => {
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);
    const res = await request(app).post("/branches").set("Authorization", `Bearer ${token}`).send(validPayload());
    expect(res.status).toBe(403);
  });

  it("allows a manager to create a branch", async () => {
    const manager = await createTestUser(businessId, "manager");
    const token = mintAccessToken(manager);
    const res = await request(app).post("/branches").set("Authorization", `Bearer ${token}`).send(validPayload());
    expect(res.status).toBe(201);
  });

  it("allows super_admin to bypass the owner/manager restriction", async () => {
    const admin = await createTestUser(businessId, "super_admin");
    const token = mintAccessToken(admin);
    const res = await request(app).post("/branches").set("Authorization", `Bearer ${token}`).send(validPayload());
    expect(res.status).toBe(201);
  });

  it("returns 400 for a missing name", async () => {
    const res = await request(app).post("/branches").set("Authorization", `Bearer ${ownerToken}`).send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed managerId", async () => {
    const res = await request(app)
      .post("/branches")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...validPayload(), managerId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when managerId references a user in a different business", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);

    const res = await request(app)
      .post("/branches")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...validPayload(), managerId: otherOwner.ownerId });
    expect(res.status).toBe(404);
  });

  it("creates, lists, gets, updates, archives, and restores a branch (full lifecycle)", async () => {
    const payload = validPayload();
    const createRes = await request(app).post("/branches").set("Authorization", `Bearer ${ownerToken}`).send(payload);
    expect(createRes.status).toBe(201);
    const branchId = createRes.body.data.id;
    expect(createRes.body.data).toMatchObject({ name: payload.name, location: payload.location, status: "active" });

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: branchId, action: "branch.created" } });
    expect(auditRows).toHaveLength(1);

    const listRes = await request(app)
      .get("/branches")
      .query({ search: payload.name })
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((b: { id: string }) => b.id === branchId)).toBe(true);
    expect(listRes.body.pagination).toMatchObject({ page: 1, pageSize: 20 });

    const getRes = await request(app).get(`/branches/${branchId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.id).toBe(branchId);

    const updateRes = await request(app)
      .patch(`/branches/${branchId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ location: "Updated St" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.location).toBe("Updated St");

    const archiveRes = await request(app).delete(`/branches/${branchId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.status).toBe("archived");

    const archiveAgainRes = await request(app).delete(`/branches/${branchId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(archiveAgainRes.status).toBe(400);

    const restoreRes = await request(app).post(`/branches/${branchId}/restore`).set("Authorization", `Bearer ${ownerToken}`);
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.status).toBe("active");

    const restoreAgainRes = await request(app).post(`/branches/${branchId}/restore`).set("Authorization", `Bearer ${ownerToken}`);
    expect(restoreAgainRes.status).toBe(400);
  });

  it("isolates branches across businesses (404, not 403, not a data leak)", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);

    const otherBranch = await createTestBranch(otherOwner.businessId);

    const getRes = await request(app)
      .get(`/branches/${otherBranch.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(404);

    const updateRes = await request(app)
      .patch(`/branches/${otherBranch.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Hijacked" });
    expect(updateRes.status).toBe(404);

    const listRes = await request(app).get("/branches").set("Authorization", `Bearer ${otherLogin.accessToken}`);
    expect(listRes.body.data.every((b: { business_id: string }) => b.business_id === otherOwner.businessId)).toBe(true);
  });
});
