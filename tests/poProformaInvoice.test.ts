import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import {
  signupTestOwner,
  loginTestOwner,
  createTestUser,
  mintAccessToken,
  createTestBranch,
  createTestProduct,
  createTestSupplier,
} from "./helpers/factories";
import type { UserRole } from "@prisma/client";

describe("PO Proforma Invoice", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let branchId: string;

  const idemKey = () => `test-${randomUUID()}`;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;
    const branch = await createTestBranch(businessId);
    branchId = branch.id;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  function futureDate(daysFromNow: number): string {
    return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
  }

  async function createSentPo(costPrice = 10, quantity = 5) {
    const supplier = await createTestSupplier(businessId);
    const product = await createTestProduct(businessId, { costPrice });
    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: quantity, unitCostSnapshot: costPrice }] });
    const sendRes = await request(app)
      .post(`/purchase-orders/${createRes.body.data.id}/send`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: createRes.body.data.version });
    return { po: sendRes.body.data, supplier, product };
  }

  describe("RBAC", () => {
    const cases: { role: UserRole; canIssue: boolean; canView: boolean }[] = [
      { role: "owner", canIssue: true, canView: true },
      { role: "manager", canIssue: true, canView: true },
      { role: "accountant", canIssue: false, canView: true },
      { role: "storekeeper", canIssue: false, canView: false },
      { role: "cashier", canIssue: false, canView: false },
      { role: "shareholder", canIssue: false, canView: false },
      { role: "custom", canIssue: false, canView: false },
      { role: "super_admin", canIssue: true, canView: true },
    ];

    it.each(cases)("role=$role issue=$canIssue view=$canView", async ({ role, canIssue, canView }) => {
      const { po } = await createSentPo();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const issueRes = await request(app)
        .post(`/purchase-orders/${po.id}/proforma-invoices`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ validUntil: futureDate(30) });
      expect(issueRes.status).toBe(canIssue ? 201 : 403);

      const listRes = await request(app).get(`/purchase-orders/${po.id}/proforma-invoices`).set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);
    });
  });

  describe("Issuance gate", () => {
    it("400s issuing against a DRAFT purchase order", async () => {
      const supplier = await createTestSupplier(businessId);
      const product = await createTestProduct(businessId);
      const createRes = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 5, unitCostSnapshot: 10 }] });

      const res = await request(app)
        .post(`/purchase-orders/${createRes.body.data.id}/proforma-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ validUntil: futureDate(30) });
      expect(res.status).toBe(400);
    });

    it("400s a validUntil in the past", async () => {
      const { po } = await createSentPo();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/proforma-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ validUntil: futureDate(-1) });
      expect(res.status).toBe(400);
    });
  });

  describe("Total computation and fallback source", () => {
    it("falls back to the PO's own total_expected_value when no Agreement Snapshot exists yet", async () => {
      const { po } = await createSentPo(10, 5); // 5 * 10 = 50
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/proforma-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ shippingCost: 15, insurance: 5, validUntil: futureDate(30) });
      expect(res.status).toBe(201);
      expect(res.body.data.subtotal).toBe("50");
      expect(res.body.data.shipping_cost).toBe("15");
      expect(res.body.data.insurance).toBe("5");
      expect(res.body.data.total).toBe("70");
      expect(res.body.data.agreement_snapshot_id).toBeNull();
      expect(res.body.data.invoice_number).toMatch(/^PFI-\d{6}$/);
    });

    it("sources subtotal from the latest Agreement Snapshot when a negotiation has been accepted", async () => {
      const { po } = await createSentPo(10, 5); // starts at 50
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const draft = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }] }); // 8 * 10 = 80
      const submitted = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${draft.body.data.id}/submit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: draft.body.data.version });
      await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${submitted.body.data.id}/accept`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/proforma-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ validUntil: futureDate(30) });
      expect(res.status).toBe(201);
      expect(res.body.data.subtotal).toBe("80");
      expect(res.body.data.agreement_snapshot_id).not.toBeNull();
    });
  });

  it("supersedes the prior Proforma Invoice when a new one is issued", async () => {
    const { po } = await createSentPo();
    const first = await request(app)
      .post(`/purchase-orders/${po.id}/proforma-invoices`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ validUntil: futureDate(30) });
    expect(first.body.data.status).toBe("issued");

    const second = await request(app)
      .post(`/purchase-orders/${po.id}/proforma-invoices`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ validUntil: futureDate(45) });
    expect(second.status).toBe(201);

    const firstReloaded = await prisma.po_proforma_invoices.findUniqueOrThrow({ where: { id: first.body.data.id } });
    expect(firstReloaded.status).toBe("superseded");

    const secondReloaded = await prisma.po_proforma_invoices.findUniqueOrThrow({ where: { id: second.body.data.id } });
    expect(secondReloaded.status).toBe("issued");
  });

  it("GET a single invoice returns UNPAID payment status with zero advance payments", async () => {
    const { po } = await createSentPo();
    const issued = await request(app)
      .post(`/purchase-orders/${po.id}/proforma-invoices`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ validUntil: futureDate(30) });

    const res = await request(app)
      .get(`/purchase-orders/${po.id}/proforma-invoices/${issued.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.paymentStatus).toBe("UNPAID");
    expect(res.body.data.amountPaid).toBe("0");
  });

  it("isolates proforma invoices across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createSentPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/proforma-invoices`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ validUntil: futureDate(30) });
    expect(res.status).toBe(404);
  });
});
