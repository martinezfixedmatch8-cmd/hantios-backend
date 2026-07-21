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

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/payment-methods").send(validPayload());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a cashier (not owner/manager)", async () => {
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);
    const res = await request(app).post("/payment-methods").set("Authorization", `Bearer ${token}`).send(validPayload());
    expect(res.status).toBe(403);
  });

  it("allows super_admin to bypass the owner/manager restriction", async () => {
    const admin = await createTestUser(businessId, "super_admin");
    const token = mintAccessToken(admin);
    const res = await request(app).post("/payment-methods").set("Authorization", `Bearer ${token}`).send(validPayload());
    expect(res.status).toBe(201);
  });

  it("returns 400 for a missing name", async () => {
    const res = await request(app).post("/payment-methods").set("Authorization", `Bearer ${ownerToken}`).send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid logoUrl", async () => {
    const res = await request(app)
      .post("/payment-methods")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...validPayload(), logoUrl: "not-a-url" });
    expect(res.status).toBe(400);
  });

  it("creates, lists, gets, updates, archives, and restores a payment method (full lifecycle)", async () => {
    const payload = validPayload();
    const createRes = await request(app)
      .post("/payment-methods")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send(payload);
    expect(createRes.status).toBe(201);
    const id = createRes.body.data.id;
    expect(createRes.body.data).toMatchObject({ name: payload.name, account_number: payload.accountNumber, status: "active" });

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
      .send({ description: "Cash on delivery" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.description).toBe("Cash on delivery");

    const archiveRes = await request(app).delete(`/payment-methods/${id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.status).toBe("archived");

    const restoreRes = await request(app).post(`/payment-methods/${id}/restore`).set("Authorization", `Bearer ${ownerToken}`);
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.status).toBe("active");
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
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(archiveRes.status).toBe(404);
  });
});
