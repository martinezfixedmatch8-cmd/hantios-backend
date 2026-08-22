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

  const idemKey = () => `test-${randomUUID()}`;

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

  async function createBranch(token = ownerToken, payload: Record<string, unknown> = validPayload(), key = idemKey()) {
    return request(app).post("/branches").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send(payload);
  }

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/branches").send(validPayload());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a cashier (not owner/manager)", async () => {
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);
    const res = await createBranch(token);
    expect(res.status).toBe(403);
  });

  // Batch 6 (HNT2-MD-001, Option A) -- create now requires Idempotency-Key.
  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await request(app).post("/branches").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
    expect(res.status).toBe(400);
  });

  it("allows a manager to create a branch", async () => {
    const manager = await createTestUser(businessId, "manager");
    const token = mintAccessToken(manager);
    const res = await createBranch(token);
    expect(res.status).toBe(201);
  });

  it("allows super_admin to bypass the owner/manager restriction", async () => {
    const admin = await createTestUser(businessId, "super_admin");
    const token = mintAccessToken(admin);
    const res = await createBranch(token);
    expect(res.status).toBe(201);
  });

  it("returns 400 for a missing name", async () => {
    const res = await createBranch(ownerToken, {});
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed managerId", async () => {
    const res = await createBranch(ownerToken, { ...validPayload(), managerId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when managerId references a user in a different business", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);

    const res = await createBranch(ownerToken, { ...validPayload(), managerId: otherOwner.ownerId });
    expect(res.status).toBe(404);
  });

  // Batch 6 (HNT2-MD-001) -- same key replay must return the stored
  // original outcome and must not create a second record or duplicate
  // audit event.
  it("idempotent replay: the same key returns the original response and creates exactly one branch", async () => {
    const key = idemKey();
    const payload = validPayload();
    const first = await createBranch(ownerToken, payload, key);
    expect(first.status).toBe(201);
    const second = await createBranch(ownerToken, payload, key);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const rows = await prisma.branches.findMany({ where: { business_id: businessId, name: payload.name } });
    expect(rows).toHaveLength(1);
    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: first.body.data.id, action: "branch.created" } });
    expect(auditRows).toHaveLength(1);
  });

  it("creates, lists, gets, updates, archives, and restores a branch (full lifecycle)", async () => {
    const payload = validPayload();
    const createRes = await createBranch(ownerToken, payload);
    expect(createRes.status).toBe(201);
    const branchId = createRes.body.data.id;
    expect(createRes.body.data).toMatchObject({ name: payload.name, location: payload.location, status: "active", version: 0 });

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
      .send({ location: "Updated St", version: 0 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.location).toBe("Updated St");
    expect(updateRes.body.data.version).toBe(1);

    const archiveRes = await request(app)
      .delete(`/branches/${branchId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 1 });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.status).toBe("archived");

    // Batch 6 -- already-archived is now a successful no-op (state-based
    // idempotency), not a 400. A plain 400 here would contradict the
    // idempotent-replay requirement.
    const archiveAgainRes = await request(app)
      .delete(`/branches/${branchId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 2 });
    expect(archiveAgainRes.status).toBe(200);
    expect(archiveAgainRes.body.data.status).toBe("archived");

    const restoreRes = await request(app)
      .post(`/branches/${branchId}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 2 });
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.status).toBe("active");

    const restoreAgainRes = await request(app)
      .post(`/branches/${branchId}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 3 });
    expect(restoreAgainRes.status).toBe(200);
    expect(restoreAgainRes.body.data.status).toBe("active");
  });

  // Batch 6 (HNT2-MD-001) -- stale-version conflict.
  it("returns 409 for a stale version on update/archive/restore", async () => {
    const createRes = await createBranch();
    const branchId = createRes.body.data.id;

    const updateRes = await request(app)
      .patch(`/branches/${branchId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Renamed", version: 99 });
    expect(updateRes.status).toBe(409);

    const archiveRes = await request(app)
      .delete(`/branches/${branchId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 99 });
    expect(archiveRes.status).toBe(409);
  });

  // Batch 6 (HNT2-MD-001) -- two concurrent updates to the same branch:
  // exactly one succeeds, one gets a stale-version 409.
  it("under real concurrency, exactly one of two simultaneous updates on the same branch succeeds", async () => {
    const createRes = await createBranch();
    const branchId = createRes.body.data.id;

    const [a, b] = await Promise.all([
      request(app).patch(`/branches/${branchId}`).set("Authorization", `Bearer ${ownerToken}`).send({ name: "Name A", version: 0 }),
      request(app).patch(`/branches/${branchId}`).set("Authorization", `Bearer ${ownerToken}`).send({ name: "Name B", version: 0 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
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
      .send({ name: "Hijacked", version: 0 });
    expect(updateRes.status).toBe(404);

    const listRes = await request(app).get("/branches").set("Authorization", `Bearer ${otherLogin.accessToken}`);
    expect(listRes.body.data.every((b: { business_id: string }) => b.business_id === otherOwner.businessId)).toBe(true);
  });
});
