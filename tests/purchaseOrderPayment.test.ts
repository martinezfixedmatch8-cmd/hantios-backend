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

describe("Purchase Order Payments", () => {
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

  async function createConfirmedPo(quantityOrdered = 10, unitCostSnapshot = 10) {
    const supplier = await createTestSupplier(businessId);
    const product = await createTestProduct(businessId, { costPrice: 8 });

    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered, unitCostSnapshot }] });
    if (createRes.status !== 201) throw new Error(`create PO failed: ${createRes.status} ${JSON.stringify(createRes.body)}`);
    const po = createRes.body.data;

    const sendRes = await request(app)
      .post(`/purchase-orders/${po.id}/send`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version });

    await request(app)
      .post(`/purchase-orders/${po.id}/confirm`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: sendRes.body.data.version });

    // send/confirm's own response bodies don't include purchase_order_items
    // (only create/update/get do) -- re-fetch via GET for the full shape.
    const fullPoRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
    return { po: fullPoRes.body.data, supplier, product };
  }

  // Fully receives the PO's single line item at exactly its snapshotted
  // unit cost, so cumulative GRN-received value == total_expected_value
  // exactly (grnVariance = 0) -- the common fixture for a "matched" payment.
  async function createFullyReceivedPo(quantityOrdered = 10, unitCostSnapshot = 10) {
    const { po, supplier, product } = await createConfirmedPo(quantityOrdered, unitCostSnapshot);
    const poItemId = po.purchase_order_items[0].id;
    const grnRes = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, items: [{ poItemId, quantityReceived: quantityOrdered, unitCostActual: unitCostSnapshot }] });
    if (grnRes.status !== 201) throw new Error(`GRN failed: ${grnRes.status} ${JSON.stringify(grnRes.body)}`);

    const updatedPoRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
    return { po: updatedPoRes.body.data, supplier, product, grn: grnRes.body.data };
  }

  describe("RBAC", () => {
    const cases: { role: UserRole; canWrite: boolean }[] = [
      { role: "owner", canWrite: true },
      { role: "manager", canWrite: true },
      { role: "storekeeper", canWrite: false },
      { role: "accountant", canWrite: false },
      { role: "cashier", canWrite: false },
      { role: "shareholder", canWrite: false },
      { role: "custom", canWrite: false },
      { role: "super_admin", canWrite: true },
    ];

    it.each(cases)("role=$role write=$canWrite", async ({ role, canWrite }) => {
      const { po } = await createFullyReceivedPo();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, amount: 100, invoiceAmount: 100, paymentDate: "2026-08-01" });
      expect(res.status).toBe(canWrite ? 201 : 403);
    });
  });

  it("returns 401 with no token", async () => {
    const { po } = await createFullyReceivedPo();
    const res = await request(app).post(`/purchase-orders/${po.id}/payments`).send({ version: po.version, amount: 100, invoiceAmount: 100, paymentDate: "2026-08-01" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const { po } = await createFullyReceivedPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ version: po.version, amount: 100, invoiceAmount: 100, paymentDate: "2026-08-01" });
    expect(res.status).toBe(400);
  });

  it("records a matched payment (invoice + GRN value both equal to expected value)", async () => {
    const { po } = await createFullyReceivedPo(10, 10); // expected = 100
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, amount: 100, invoiceAmount: 100, invoiceReference: "INV-001", paymentDate: "2026-08-01" });

    expect(res.status).toBe(201);
    expect(res.body.data.payment.match_status).toBe("matched");
    expect(res.body.data.payment.match_overridden).toBe(false);
    expect(res.body.data.purchaseOrder.payment_status).toBe("paid");
    expect(res.body.data.purchaseOrder.paid_amount).toBe("100");
    expect(res.body.data.purchaseOrder.remaining_amount).toBe("0");

    // Auto-created Expense: correct source/category/workflow bypass/snapshots.
    const expense = res.body.data.expense;
    expect(expense.source).toBe("purchase_order");
    expect(expense.workflow_status).toBe("paid");
    expect(expense.approved_by).toBeTruthy();
    expect(expense.paid_by).toBeTruthy();
    expect(expense.category_name).toBe("Inventory Purchases");
    expect(expense.purchase_order_id).toBe(po.id);
    expect(expense.po_number).toBe(po.po_number);
    expect(expense.grn_number).toMatch(/^GRN-\d{6}$/);
    expect(expense.vendor_id).toBeNull();
    expect(expense.vendor_name).toBeNull();

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: res.body.data.payment.id, action: "purchase_order.payment_recorded" } });
    expect(auditRows).toHaveLength(1);
  });

  it("comma-joins multiple GRN numbers on the auto-created expense", async () => {
    const { po, product } = await createConfirmedPo(10, 10);
    const poItemId = po.purchase_order_items[0].id;

    const grn1 = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, items: [{ poItemId, quantityReceived: 5, unitCostActual: 10 }] });

    const afterFirst = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
    const grn2 = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: afterFirst.body.data.version, items: [{ poItemId, quantityReceived: 5, unitCostActual: 10 }] });

    const afterSecond = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
    const paymentRes = await request(app)
      .post(`/purchase-orders/${po.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: afterSecond.body.data.version, amount: 100, invoiceAmount: 100, paymentDate: "2026-08-01" });

    expect(paymentRes.status).toBe(201);
    expect(paymentRes.body.data.expense.grn_number).toBe(`${grn1.body.data.grn_number}, ${grn2.body.data.grn_number}`);
    void product;
  });

  it("rejects a mismatched payment without a matchOverride (400 with match details)", async () => {
    const { po } = await createConfirmedPo(10, 10); // expected = 100, no GRN received yet (grnReceivedValue = 0)
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, amount: 100, invoiceAmount: 100, paymentDate: "2026-08-01" });

    expect(res.status).toBe(400);
    expect(res.body.error.details.matchStatus).toBe("match_failed");

    const payments = await prisma.purchase_order_payments.findMany({ where: { purchase_order_id: po.id } });
    expect(payments).toHaveLength(0);
  });

  it("accepts a mismatched payment with a matchOverride reason", async () => {
    const { po } = await createConfirmedPo(10, 10);
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        version: po.version,
        amount: 100,
        invoiceAmount: 100,
        paymentDate: "2026-08-01",
        matchOverride: { reason: "Supplier requires payment before delivery" },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.payment.match_status).toBe("match_failed");
    expect(res.body.data.payment.match_overridden).toBe(true);
    expect(res.body.data.payment.match_override_reason).toBe("Supplier requires payment before delivery");
  });

  it("rejects a payment amount exceeding the remaining balance", async () => {
    const { po } = await createFullyReceivedPo(10, 10); // expected = 100
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, amount: 150, invoiceAmount: 100, paymentDate: "2026-08-01" });
    expect(res.status).toBe(400);
  });

  it("supports partial payments -- payment_status transitions unpaid -> partially_paid -> paid", async () => {
    const { po } = await createFullyReceivedPo(10, 10); // expected = 100

    const first = await request(app)
      .post(`/purchase-orders/${po.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, amount: 40, invoiceAmount: 100, paymentDate: "2026-08-01" });
    expect(first.status).toBe(201);
    expect(first.body.data.purchaseOrder.payment_status).toBe("partially_paid");
    expect(first.body.data.purchaseOrder.remaining_amount).toBe("60");

    const second = await request(app)
      .post(`/purchase-orders/${po.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: first.body.data.purchaseOrder.version, amount: 60, invoiceAmount: 100, paymentDate: "2026-08-01" });
    expect(second.status).toBe(201);
    expect(second.body.data.purchaseOrder.payment_status).toBe("paid");
    expect(second.body.data.purchaseOrder.remaining_amount).toBe("0");
  });

  it("replays the identical response for a repeated Idempotency-Key", async () => {
    const { po } = await createFullyReceivedPo(10, 10);
    const key = idemKey();
    const payload = { version: po.version, amount: 100, invoiceAmount: 100, paymentDate: "2026-08-01" };

    const first = await request(app).post(`/purchase-orders/${po.id}/payments`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    const second = await request(app).post(`/purchase-orders/${po.id}/payments`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it("a concurrent payment race on the same version lets exactly one win", async () => {
    const { po } = await createFullyReceivedPo(10, 10);

    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/purchase-orders/${po.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", `test-concurrent-a-${po.id}`)
        .send({ version: po.version, amount: 50, invoiceAmount: 100, paymentDate: "2026-08-01" }),
      request(app)
        .post(`/purchase-orders/${po.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", `test-concurrent-b-${po.id}`)
        .send({ version: po.version, amount: 50, invoiceAmount: 100, paymentDate: "2026-08-01" }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const payments = await prisma.purchase_order_payments.findMany({ where: { purchase_order_id: po.id } });
    expect(payments).toHaveLength(1);
  });

  it("isolates purchase orders across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createFullyReceivedPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/payments`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, amount: 10, invoiceAmount: 10, paymentDate: "2026-08-01" });
    expect(res.status).toBe(404);
  });
});
