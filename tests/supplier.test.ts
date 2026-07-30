import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestSupplier } from "./helpers/factories";
import type { UserRole } from "@prisma/client";

describe("Suppliers", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;

  const idemKey = () => `test-${randomUUID()}`;
  const validPayload = () => ({ name: `Test Supplier Co ${randomUUID()}`, phone: "+254712345678", email: "supplier@example.test" });

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

  describe("RBAC", () => {
    const cases: { role: UserRole; canWrite: boolean; canView: boolean }[] = [
      { role: "owner", canWrite: true, canView: true },
      { role: "manager", canWrite: true, canView: true },
      { role: "accountant", canWrite: false, canView: true },
      { role: "storekeeper", canWrite: false, canView: true },
      { role: "cashier", canWrite: false, canView: false },
      { role: "shareholder", canWrite: false, canView: false },
      { role: "custom", canWrite: false, canView: false },
      { role: "super_admin", canWrite: true, canView: true },
    ];

    it.each(cases)("role=$role write=$canWrite view=$canView", async ({ role, canWrite, canView }) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const createRes = await request(app)
        .post("/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send(validPayload());
      expect(createRes.status).toBe(canWrite ? 201 : 403);

      const listRes = await request(app).get("/suppliers").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);
    });
  });

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/suppliers").send(validPayload());
    expect(res.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await request(app).post("/suppliers").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
    expect(res.status).toBe(400);
  });

  it("returns 400 for a missing name", async () => {
    const res = await request(app)
      .post("/suppliers")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ phone: "+254700000000" });
    expect(res.status).toBe(400);
  });

  it("replays the identical response for a repeated Idempotency-Key", async () => {
    const key = idemKey();
    const payload = validPayload();
    const first = await request(app).post("/suppliers").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    const second = await request(app).post("/suppliers").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it("creates, lists, gets, updates, archives, and restores a supplier (full lifecycle)", async () => {
    const payload = validPayload();
    const createRes = await request(app)
      .post("/suppliers")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(payload);
    expect(createRes.status).toBe(201);
    const supplierId = createRes.body.data.id;
    expect(createRes.body.data).toMatchObject({ name: payload.name, phone: payload.phone, email: payload.email, status: "active", version: 0 });

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: supplierId, action: "supplier.created" } });
    expect(auditRows).toHaveLength(1);

    const listRes = await request(app).get("/suppliers").query({ search: payload.name }).set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((s: { id: string }) => s.id === supplierId)).toBe(true);
    expect(listRes.body.pagination).toMatchObject({ page: 1, pageSize: 20 });

    const getRes = await request(app).get(`/suppliers/${supplierId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.id).toBe(supplierId);

    const updateRes = await request(app)
      .patch(`/suppliers/${supplierId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ version: 0, phone: "+254799999999" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.phone).toBe("+254799999999");
    expect(updateRes.body.data.version).toBe(1);

    // Stale version -> 409, not a silent overwrite.
    const staleRes = await request(app)
      .patch(`/suppliers/${supplierId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ version: 0, name: "Should Not Apply" });
    expect(staleRes.status).toBe(409);

    // Explicit null clears a nullable field.
    const clearRes = await request(app)
      .patch(`/suppliers/${supplierId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ version: 1, email: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.data.email).toBeNull();

    const archiveRes = await request(app)
      .post(`/suppliers/${supplierId}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 2, reason: "No longer sourcing from this supplier" });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.status).toBe("archived");

    const archiveAgainRes = await request(app)
      .post(`/suppliers/${supplierId}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 3, reason: "Again" });
    expect(archiveAgainRes.status).toBe(400);

    const restoreRes = await request(app)
      .post(`/suppliers/${supplierId}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ version: 3 });
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.status).toBe("active");

    const restoreAgainRes = await request(app)
      .post(`/suppliers/${supplierId}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ version: 4 });
    expect(restoreAgainRes.status).toBe(400);
  });

  it("isolates suppliers across businesses (404, not a data leak)", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherSupplier = await createTestSupplier(otherOwner.businessId);

    const getRes = await request(app).get(`/suppliers/${otherSupplier.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(404);

    const updateRes = await request(app)
      .patch(`/suppliers/${otherSupplier.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ version: 0, name: "Hijacked" });
    expect(updateRes.status).toBe(404);

    const listRes = await request(app).get("/suppliers").set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.body.data.every((s: { id: string }) => s.id !== otherSupplier.id)).toBe(true);
  });
});
