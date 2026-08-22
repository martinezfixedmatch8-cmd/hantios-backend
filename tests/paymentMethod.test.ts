import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestPaymentMethod } from "./helpers/factories";

describe("Payment Methods", () => {
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

  const validPayload = () => ({ name: `Cash ${randomUUID()}`, accountNumber: "0000" });

  async function createPaymentMethod(token = ownerToken, payload: Record<string, unknown> = validPayload(), key = idemKey()) {
    return request(app).post("/payment-methods").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send(payload);
  }

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/payment-methods").send(validPayload());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a cashier (not owner/manager)", async () => {
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);
    const res = await createPaymentMethod(token);
    expect(res.status).toBe(403);
  });

  // Batch 6 (HNT2-MD-001, Option A) -- create now requires Idempotency-Key.
  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await request(app).post("/payment-methods").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
    expect(res.status).toBe(400);
  });

  it("allows super_admin to bypass the owner/manager restriction", async () => {
    const admin = await createTestUser(businessId, "super_admin");
    const token = mintAccessToken(admin);
    const res = await createPaymentMethod(token);
    expect(res.status).toBe(201);
  });

  it("returns 400 for a missing name", async () => {
    const res = await createPaymentMethod(ownerToken, {});
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid logoUrl", async () => {
    const res = await createPaymentMethod(ownerToken, { ...validPayload(), logoUrl: "not-a-url" });
    expect(res.status).toBe(400);
  });

  it("idempotent replay: the same key returns the original response and creates exactly one payment method", async () => {
    const key = idemKey();
    const payload = validPayload();
    const first = await createPaymentMethod(ownerToken, payload, key);
    expect(first.status).toBe(201);
    const second = await createPaymentMethod(ownerToken, payload, key);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const rows = await prisma.payment_methods.findMany({ where: { business_id: businessId, name: payload.name } });
    expect(rows).toHaveLength(1);
  });

  it("creates, lists, gets, updates, archives, and restores a payment method (full lifecycle)", async () => {
    const payload = validPayload();
    const createRes = await createPaymentMethod(ownerToken, payload);
    expect(createRes.status).toBe(201);
    const id = createRes.body.data.id;
    expect(createRes.body.data).toMatchObject({ name: payload.name, account_number: payload.accountNumber, status: "active", version: 0 });

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: id, action: "payment_method.created" } });
    expect(auditRows).toHaveLength(1);

    const listRes = await request(app)
      .get("/payment-methods")
      .query({ search: payload.name })
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((p: { id: string }) => p.id === id)).toBe(true);

    const getRes = await request(app).get(`/payment-methods/${id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);

    const updateRes = await request(app)
      .patch(`/payment-methods/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Cash on delivery", version: 0 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.description).toBe("Cash on delivery");
    expect(updateRes.body.data.version).toBe(1);

    const archiveRes = await request(app)
      .delete(`/payment-methods/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 1 });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.status).toBe("archived");

    // Batch 6 -- already-archived is a successful no-op, not a 400.
    const archiveAgainRes = await request(app)
      .delete(`/payment-methods/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 2 });
    expect(archiveAgainRes.status).toBe(200);
    expect(archiveAgainRes.body.data.status).toBe("archived");

    const restoreRes = await request(app)
      .post(`/payment-methods/${id}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 2 });
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.status).toBe("active");
  });

  it("returns 409 for a stale version on update/archive/restore", async () => {
    const createRes = await createPaymentMethod();
    const id = createRes.body.data.id;

    const updateRes = await request(app)
      .patch(`/payment-methods/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "x", version: 99 });
    expect(updateRes.status).toBe(409);

    const archiveRes = await request(app)
      .delete(`/payment-methods/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 99 });
    expect(archiveRes.status).toBe(409);
  });

  it("under real concurrency, exactly one of two simultaneous updates on the same payment method succeeds", async () => {
    const createRes = await createPaymentMethod();
    const id = createRes.body.data.id;

    const [a, b] = await Promise.all([
      request(app).patch(`/payment-methods/${id}`).set("Authorization", `Bearer ${ownerToken}`).send({ description: "A", version: 0 }),
      request(app).patch(`/payment-methods/${id}`).set("Authorization", `Bearer ${ownerToken}`).send({ description: "B", version: 0 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("isolates payment methods across businesses (404, not a data leak)", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherPaymentMethod = await createTestPaymentMethod(otherOwner.businessId);

    const getRes = await request(app)
      .get(`/payment-methods/${otherPaymentMethod.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(404);

    const archiveRes = await request(app)
      .delete(`/payment-methods/${otherPaymentMethod.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 0 });
    expect(archiveRes.status).toBe(404);
  });
});
