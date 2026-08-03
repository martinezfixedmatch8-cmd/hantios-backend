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

describe("Goods Received Notes", () => {
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

  // Creates a real PO (via the actual HTTP endpoint, exercising numbering/
  // idempotency for free) and drives it to CONFIRMED -- the common
  // receivable state most GRN tests need.
  async function createConfirmedPo(quantityOrdered = 10, unitCostSnapshot = 12.5) {
    const supplier = await createTestSupplier(businessId);
    const product = await createTestProduct(businessId, { costPrice: 10 });

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
    if (sendRes.status !== 200) throw new Error(`send PO failed: ${sendRes.status} ${JSON.stringify(sendRes.body)}`);

    const confirmRes = await request(app)
      .post(`/purchase-orders/${po.id}/confirm`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: sendRes.body.data.version });
    if (confirmRes.status !== 200) throw new Error(`confirm PO failed: ${confirmRes.status} ${JSON.stringify(confirmRes.body)}`);

    // send/confirm's own response bodies don't include purchase_order_items
    // (only create/update/get do) -- re-fetch via GET for the full shape.
    const fullPoRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
    return { po: fullPoRes.body.data, supplier, product };
  }

  describe("RBAC", () => {
    const cases: { role: UserRole; canWrite: boolean }[] = [
      { role: "owner", canWrite: true },
      { role: "manager", canWrite: true },
      { role: "storekeeper", canWrite: true },
      { role: "accountant", canWrite: false },
      { role: "cashier", canWrite: false },
      { role: "shareholder", canWrite: false },
      { role: "custom", canWrite: false },
      { role: "super_admin", canWrite: true },
    ];

    it.each(cases)("role=$role write=$canWrite", async ({ role, canWrite }) => {
      const { po } = await createConfirmedPo();
      const poItemId = po.purchase_order_items[0].id;
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/goods-received-notes`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, items: [{ poItemId, quantityReceived: 10, unitCostActual: 12.5 }] });
      expect(res.status).toBe(canWrite ? 201 : 403);
    });
  });

  it("returns 401 with no token", async () => {
    const { po } = await createConfirmedPo();
    const res = await request(app).post(`/purchase-orders/${po.id}/goods-received-notes`).send({ version: po.version, items: [] });
    expect(res.status).toBe(401);
  });

  it("returns 400 for an empty items array", async () => {
    const { po } = await createConfirmedPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, items: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a duplicate poItemId within one GRN", async () => {
    const { po } = await createConfirmedPo();
    const poItemId = po.purchase_order_items[0].id;
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        version: po.version,
        items: [
          { poItemId, quantityReceived: 5, unitCostActual: 12.5 },
          { poItemId, quantityReceived: 5, unitCostActual: 12.5 },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a GRN against a DRAFT purchase order", async () => {
    const supplier = await createTestSupplier(businessId);
    const product = await createTestProduct(businessId);
    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 5, unitCostSnapshot: 10 }] });
    const po = createRes.body.data;

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, items: [{ poItemId: po.purchase_order_items[0].id, quantityReceived: 5, unitCostActual: 10 }] });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a poItemId belonging to a different purchase order", async () => {
    const { po: po1 } = await createConfirmedPo();
    const { po: po2 } = await createConfirmedPo();

    const res = await request(app)
      .post(`/purchase-orders/${po1.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        version: po1.version,
        items: [{ poItemId: po2.purchase_order_items[0].id, quantityReceived: 1, unitCostActual: 10 }],
      });
    expect(res.status).toBe(404);
  });

  it("replays the identical response for a repeated Idempotency-Key", async () => {
    const { po } = await createConfirmedPo();
    const poItemId = po.purchase_order_items[0].id;
    const key = idemKey();
    const payload = { version: po.version, items: [{ poItemId, quantityReceived: 10, unitCostActual: 12.5 }] };

    const first = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send(payload);
    const second = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it("a full single-shipment receipt marks the PO 'received' and stocks the warehouse", async () => {
    const { po, product } = await createConfirmedPo(10, 12.5);
    const poItemId = po.purchase_order_items[0].id;

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        version: po.version,
        supplierDeliveryNote: "DN-12345",
        items: [{ poItemId, quantityReceived: 10, unitCostActual: 12.5 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.grn_number).toMatch(/^GRN-\d{6}$/);
    expect(res.body.data.goods_received_items).toHaveLength(1);
    expect(res.body.data.goods_received_items[0].variance_quantity).toBe("0");

    const updatedPoRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(updatedPoRes.body.data.status).toBe("received");
    expect(updatedPoRes.body.data.goods_received_notes).toHaveLength(1);

    const stockRow = await prisma.warehouse_stock.findFirst({ where: { business_id: businessId, product_id: product.id } });
    expect(stockRow?.quantity.toString()).toBe("10");

    const movement = await prisma.warehouse_movements.findFirst({ where: { business_id: businessId, product_id: product.id } });
    expect(movement?.movement_type).toBe("stock_in");
    expect(movement?.grn_id).toBe(res.body.data.id);

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: res.body.data.id, action: "purchase_order.goods_received" } });
    expect(auditRows).toHaveLength(1);
  });

  it("partial receipt across two GRNs: partially_received first, then received once fully delivered", async () => {
    const { po } = await createConfirmedPo(10, 12.5);
    const poItemId = po.purchase_order_items[0].id;

    const first = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, items: [{ poItemId, quantityReceived: 6, unitCostActual: 12.5 }] });
    expect(first.status).toBe(201);
    // Per-GRN variance is computed against the line's FULL ordered quantity,
    // not a running remaining-balance (locked design).
    expect(first.body.data.goods_received_items[0].variance_quantity).toBe("-4");

    const afterFirst = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(afterFirst.body.data.status).toBe("partially_received");

    const second = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: afterFirst.body.data.version, items: [{ poItemId, quantityReceived: 4, unitCostActual: 12.5 }] });
    expect(second.status).toBe(201);

    const afterSecond = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(afterSecond.body.data.status).toBe("received");
    expect(afterSecond.body.data.goods_received_notes).toHaveLength(2);
  });

  it("over-delivery still marks the PO received, flagged via a positive variance_quantity", async () => {
    const { po } = await createConfirmedPo(10, 12.5);
    const poItemId = po.purchase_order_items[0].id;

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, items: [{ poItemId, quantityReceived: 12, unitCostActual: 12.5 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.goods_received_items[0].variance_quantity).toBe("2");

    const updated = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(updated.body.data.status).toBe("received");
  });

  it("isolates GRNs across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createConfirmedPo();
    const poItemId = po.purchase_order_items[0].id;

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/goods-received-notes`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, items: [{ poItemId, quantityReceived: 1, unitCostActual: 10 }] });
    expect(res.status).toBe(404);
  });
});
