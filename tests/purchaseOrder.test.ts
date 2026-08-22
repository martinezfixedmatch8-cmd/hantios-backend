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

describe("Purchase Orders", () => {
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

  async function setup(overrides: { costPrice?: number; supplierOverrides?: Partial<{ name: string; phone: string; email: string }> } = {}) {
    const supplier = await createTestSupplier(businessId, overrides.supplierOverrides);
    const product = await createTestProduct(businessId, { costPrice: overrides.costPrice ?? 10 });
    return { supplier, product };
  }

  function poPayload(supplierId: string, productId: string, overrides: Record<string, unknown> = {}) {
    return {
      supplierId,
      branchId,
      items: [{ productId, quantityOrdered: 5, unitCostSnapshot: 12.5 }],
      ...overrides,
    };
  }

  async function createDraftPo(overrides: Record<string, unknown> = {}) {
    const { supplier, product } = await setup();
    const res = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(poPayload(supplier.id, product.id, overrides));
    if (res.status !== 201) throw new Error(`createDraftPo failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { po: res.body.data, supplier, product };
  }

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
      const { supplier, product } = await setup();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const createRes = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send(poPayload(supplier.id, product.id));
      expect(createRes.status).toBe(canWrite ? 201 : 403);

      const listRes = await request(app).get("/purchase-orders").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);
    });

    it("storekeeper is read-only: can view but cannot send/confirm/cancel/patch", async () => {
      const { po } = await createDraftPo();
      const storekeeper = await createTestUser(businessId, "storekeeper");
      const token = mintAccessToken(storekeeper);

      const getRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${token}`);
      expect(getRes.status).toBe(200);

      const patchRes = await request(app).patch(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${token}`).send({ version: po.version });
      expect(patchRes.status).toBe(403);

      const sendRes = await request(app)
        .post(`/purchase-orders/${po.id}/send`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });
      expect(sendRes.status).toBe(403);
    });
  });

  it("returns 401 with no token", async () => {
    const { supplier, product } = await setup();
    const res = await request(app).post("/purchase-orders").send(poPayload(supplier.id, product.id));
    expect(res.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const { supplier, product } = await setup();
    const res = await request(app).post("/purchase-orders").set("Authorization", `Bearer ${ownerToken}`).send(poPayload(supplier.id, product.id));
    expect(res.status).toBe(400);
  });

  describe("Line item validation", () => {
    it("rejects an empty PO outright (no line items)", async () => {
      const { supplier } = await setup();
      const res = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(poPayload(supplier.id, "irrelevant", { items: [] }));
      expect(res.status).toBe(400);
    });

    it("rejects duplicate products in one request instead of merging them", async () => {
      const { supplier, product } = await setup();
      const res = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(
          poPayload(supplier.id, product.id, {
            items: [
              { productId: product.id, quantityOrdered: 2, unitCostSnapshot: 10 },
              { productId: product.id, quantityOrdered: 3, unitCostSnapshot: 10 },
            ],
          })
        );
      expect(res.status).toBe(400);
    });

    it("rejects quantityOrdered <= 0", async () => {
      const { supplier, product } = await setup();
      for (const bad of [0, -1]) {
        const res = await request(app)
          .post("/purchase-orders")
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send(poPayload(supplier.id, product.id, { items: [{ productId: product.id, quantityOrdered: bad, unitCostSnapshot: 10 }] }));
        expect(res.status).toBe(400);
      }
    });

    it("rejects a negative unitCostSnapshot but allows zero", async () => {
      const { supplier, product } = await setup();
      const negativeRes = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(poPayload(supplier.id, product.id, { items: [{ productId: product.id, quantityOrdered: 1, unitCostSnapshot: -1 }] }));
      expect(negativeRes.status).toBe(400);

      const zeroRes = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(poPayload(supplier.id, product.id, { items: [{ productId: product.id, quantityOrdered: 1, unitCostSnapshot: 0 }] }));
      expect(zeroRes.status).toBe(201);
    });
  });

  describe("Cross-business isolation", () => {
    it("rejects a supplier from a different business (404)", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherSupplier = await createTestSupplier(otherOwner.businessId);
      const { product } = await setup();

      const res = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(poPayload(otherSupplier.id, product.id));
      expect(res.status).toBe(404);
    });

    it("rejects a branch from a different business (404)", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherBranch = await createTestBranch(otherOwner.businessId);
      const { supplier, product } = await setup();

      const res = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(poPayload(supplier.id, product.id, { branchId: otherBranch.id }));
      expect(res.status).toBe(404);
    });

    it("rejects a product from a different business (404, consistent with supplier/branch)", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherProduct = await createTestProduct(otherOwner.businessId);
      const { supplier } = await setup();

      const res = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(poPayload(supplier.id, otherProduct.id, { items: [{ productId: otherProduct.id, quantityOrdered: 1, unitCostSnapshot: 10 }] }));
      expect(res.status).toBe(404);
    });

    it("rejects a cross-business product on PATCH while still DRAFT (404)", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherProduct = await createTestProduct(otherOwner.businessId);
      const { po } = await createDraftPo();

      const res = await request(app)
        .patch(`/purchase-orders/${po.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: po.version, items: [{ productId: otherProduct.id, quantityOrdered: 1, unitCostSnapshot: 10 }] });
      expect(res.status).toBe(404);
    });
  });

  describe("Archived reference rejection", () => {
    it("rejects an archived supplier on create", async () => {
      const { product } = await setup();
      const archivedSupplier = await createTestSupplier(businessId, { status: "archived" });
      const res = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(poPayload(archivedSupplier.id, product.id));
      expect(res.status).toBe(400);
    });

    it("rejects an archived product line item on create", async () => {
      const { supplier } = await setup();
      const archivedProduct = await createTestProduct(businessId);
      const archiveRes = await request(app)
        .delete(`/products/${archivedProduct.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: archivedProduct.version });
      expect(archiveRes.status).toBe(200);

      const res = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(poPayload(supplier.id, archivedProduct.id, { items: [{ productId: archivedProduct.id, quantityOrdered: 1, unitCostSnapshot: 5 }] }));
      expect(res.status).toBe(400);
    });

    it("rejects an archived branch on create and on PATCH", async () => {
      const { supplier, product } = await setup();
      const archivedBranch = await createTestBranch(businessId);
      // Batch 6 (HNT2-MD-001) -- branch archive now requires a version
      // guard + Idempotency-Key; this call is incidental test setup (an
      // archived-branch fixture), not the subject under test here.
      const archiveRes = await request(app)
        .delete(`/branches/${archivedBranch.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: archivedBranch.version });
      expect(archiveRes.status).toBe(200);

      const createRes = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(poPayload(supplier.id, product.id, { branchId: archivedBranch.id }));
      expect(createRes.status).toBe(400);

      const { po } = await createDraftPo();
      const patchRes = await request(app)
        .patch(`/purchase-orders/${po.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: po.version, branchId: archivedBranch.id });
      expect(patchRes.status).toBe(400);
    });
  });

  it("creates a PO with correct product + supplier snapshots and a server-computed total that ignores any client-supplied value", async () => {
    const { supplier, product } = await setup({ supplierOverrides: { name: "Acme Supplies", phone: "+254711111111", email: "acme@example.test" } });

    const res = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(
        poPayload(supplier.id, product.id, {
          items: [{ productId: product.id, quantityOrdered: 3, unitCostSnapshot: 15 }],
          totalExpectedValue: 999999, // must be ignored -- not even accepted by the schema
        })
      );

    expect(res.status).toBe(201);
    const po = res.body.data;
    expect(po.po_number).toMatch(/^PO-\d{6}$/);
    expect(po.status).toBe("draft");
    expect(po.currency_code).toBe("KES");
    expect(po.supplier_name_snapshot).toBe("Acme Supplies");
    expect(po.supplier_phone_snapshot).toBe("+254711111111");
    expect(po.supplier_email_snapshot).toBe("acme@example.test");
    expect(Number(po.total_expected_value)).toBe(45); // 3 * 15, never 999999
    expect(po.purchase_order_items).toHaveLength(1);
    expect(po.purchase_order_items[0]).toMatchObject({
      product_id: product.id,
      product_name_snapshot: product.name,
      quantity_ordered: "3",
      unit_cost_snapshot: "15",
      line_total: "45",
    });

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: po.id, action: "purchase_order.created" } });
    expect(auditRows).toHaveLength(1);
  });

  it("replays the identical response for a repeated Idempotency-Key on create", async () => {
    const { supplier, product } = await setup();
    const key = idemKey();
    const payload = poPayload(supplier.id, product.id);
    const first = await request(app).post("/purchase-orders").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    const second = await request(app).post("/purchase-orders").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  describe("Status transitions", () => {
    it("moves draft -> sent -> confirmed", async () => {
      const { po } = await createDraftPo();

      const sendRes = await request(app)
        .post(`/purchase-orders/${po.id}/send`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });
      expect(sendRes.status).toBe(200);
      expect(sendRes.body.data.status).toBe("sent");
      expect(sendRes.body.data.version).toBe(po.version + 1);

      const confirmRes = await request(app)
        .post(`/purchase-orders/${po.id}/confirm`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sendRes.body.data.version });
      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.data.status).toBe("confirmed");
    });

    it("rejects confirm when the PO is still DRAFT (must be SENT first)", async () => {
      const { po } = await createDraftPo();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/confirm`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });
      expect(res.status).toBe(409);
    });

    it("rejects send when the PO is no longer DRAFT", async () => {
      const { po } = await createDraftPo();
      const sendRes = await request(app)
        .post(`/purchase-orders/${po.id}/send`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });
      expect(sendRes.status).toBe(200);

      const secondSendRes = await request(app)
        .post(`/purchase-orders/${po.id}/send`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sendRes.body.data.version });
      expect(secondSendRes.status).toBe(409);
    });

    it("cancels a DRAFT PO with a reason", async () => {
      const { po } = await createDraftPo();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, reason: "Ordered by mistake" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("cancelled");
      expect(res.body.data.cancel_reason).toBe("Ordered by mistake");
    });

    it("cancels a SENT PO with a reason", async () => {
      const { po } = await createDraftPo();
      const sendRes = await request(app)
        .post(`/purchase-orders/${po.id}/send`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });
      expect(sendRes.status).toBe(200);

      const cancelRes = await request(app)
        .post(`/purchase-orders/${po.id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sendRes.body.data.version, reason: "Supplier can't fulfil" });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe("cancelled");
    });

    it("rejects cancelling a CONFIRMED PO -- confirmed can never be cancelled this session", async () => {
      const { po } = await createDraftPo();
      const sendRes = await request(app)
        .post(`/purchase-orders/${po.id}/send`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });
      const confirmRes = await request(app)
        .post(`/purchase-orders/${po.id}/confirm`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sendRes.body.data.version });
      expect(confirmRes.status).toBe(200);

      const cancelRes = await request(app)
        .post(`/purchase-orders/${po.id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: confirmRes.body.data.version, reason: "Too late" });
      expect(cancelRes.status).toBe(409);
    });

    it("rejects cancel with a missing reason", async () => {
      const { po } = await createDraftPo();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });
      expect(res.status).toBe(400);
    });

    it("only lets one of two concurrent send requests win", async () => {
      const { po } = await createDraftPo();
      const [first, second] = await Promise.all([
        request(app).post(`/purchase-orders/${po.id}/send`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send({ version: po.version }),
        request(app).post(`/purchase-orders/${po.id}/send`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send({ version: po.version }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
    });

    it("only lets one of two concurrent confirm requests win", async () => {
      const { po } = await createDraftPo();
      const sendRes = await request(app)
        .post(`/purchase-orders/${po.id}/send`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });

      const [first, second] = await Promise.all([
        request(app)
          .post(`/purchase-orders/${po.id}/confirm`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: sendRes.body.data.version }),
        request(app)
          .post(`/purchase-orders/${po.id}/confirm`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: sendRes.body.data.version }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
    });

    it("assigns unique, sequential PO numbers under true concurrent creation", async () => {
      const setups = await Promise.all(Array.from({ length: 5 }, () => setup()));
      const results = await Promise.all(
        setups.map(({ supplier, product }) =>
          request(app).post("/purchase-orders").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(poPayload(supplier.id, product.id))
        )
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const numbers = results.map((r) => r.body.data.po_number);
      expect(new Set(numbers).size).toBe(5);
    });
  });

  describe("PATCH -- DRAFT-only in the fullest sense", () => {
    it("allows editing supplier/branch/exchangeRate/items while still DRAFT, with a full-replace of items and a recomputed total", async () => {
      const { po } = await createDraftPo();
      const { supplier: newSupplier, product: newProduct } = await setup({ supplierOverrides: { name: "Replacement Supplier" } });

      const res = await request(app)
        .patch(`/purchase-orders/${po.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          version: po.version,
          supplierId: newSupplier.id,
          exchangeRate: 1.25,
          items: [{ productId: newProduct.id, quantityOrdered: 2, unitCostSnapshot: 20 }],
        });
      expect(res.status).toBe(200);
      expect(res.body.data.supplier_id).toBe(newSupplier.id);
      expect(res.body.data.supplier_name_snapshot).toBe("Replacement Supplier");
      expect(Number(res.body.data.total_expected_value)).toBe(40);
      expect(Number(res.body.data.exchange_rate)).toBe(1.25);
      expect(res.body.data.purchase_order_items).toHaveLength(1);
      expect(res.body.data.purchase_order_items[0].product_id).toBe(newProduct.id);
    });

    it("rejects a stale version with 409", async () => {
      const { po } = await createDraftPo();
      const first = await request(app).patch(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`).send({ version: po.version, exchangeRate: 1.1 });
      expect(first.status).toBe(200);

      const stale = await request(app).patch(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`).send({ version: po.version, exchangeRate: 1.2 });
      expect(stale.status).toBe(409);
    });

    it("rejects any edit at all once the PO leaves DRAFT -- line items, supplier, branch, and currency are all locked", async () => {
      const { po, product } = await createDraftPo();
      const sendRes = await request(app)
        .post(`/purchase-orders/${po.id}/send`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });
      expect(sendRes.status).toBe(200);

      const attempts = [
        { exchangeRate: 2 },
        { branchId: null },
        { items: [{ productId: product.id, quantityOrdered: 1, unitCostSnapshot: 1 }] },
      ];
      for (const patch of attempts) {
        const res = await request(app)
          .patch(`/purchase-orders/${po.id}`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ version: sendRes.body.data.version, ...patch });
        expect([400, 409]).toContain(res.status);
      }

      // Confirm nothing actually changed.
      const getRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(Number(getRes.body.data.exchange_rate ?? 0)).toBe(0);
      expect(getRes.body.data.branch_id).toBe(branchId);
    });

    it("a concurrent PATCH racing a Send never lets both win -- the loser is 400 or 409, never a second success", async () => {
      const { po } = await createDraftPo();
      const [patchRes, sendRes] = await Promise.all([
        request(app).patch(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`).send({ version: po.version, exchangeRate: 3 }),
        request(app).post(`/purchase-orders/${po.id}/send`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send({ version: po.version }),
      ]);
      const successCount = [patchRes.status, sendRes.status].filter((s) => s === 200).length;
      expect(successCount).toBe(1);
      if (patchRes.status !== 200) expect([400, 409]).toContain(patchRes.status);
      if (sendRes.status !== 200) expect([400, 409]).toContain(sendRes.status);
    });
  });

  describe("Snapshot immutability", () => {
    it("is unaffected by a later Product cost/name change", async () => {
      const { po, product } = await createDraftPo();
      const originalUnitCost = po.purchase_order_items[0].unit_cost_snapshot;
      const originalNameSnapshot = po.purchase_order_items[0].product_name_snapshot;

      const productPatchRes = await request(app)
        .patch(`/products/${product.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: product.version, name: "Renamed Product", costPrice: 999, sellingPrice: Number(product.selling_price), reason: "Price renegotiated" });
      expect(productPatchRes.status).toBe(200);

      const getRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.purchase_order_items[0].product_name_snapshot).toBe(originalNameSnapshot);
      expect(getRes.body.data.purchase_order_items[0].unit_cost_snapshot).toBe(originalUnitCost);
    });

    it("is unaffected by a later Supplier name/phone/email change", async () => {
      const { po, supplier } = await createDraftPo();
      const originalName = po.supplier_name_snapshot;
      const originalPhone = po.supplier_phone_snapshot;
      const originalEmail = po.supplier_email_snapshot;

      const supplierPatchRes = await request(app)
        .patch(`/suppliers/${supplier.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: supplier.version, name: "Renamed Supplier Co", phone: "+254700000001", email: "changed@example.test" });
      expect(supplierPatchRes.status).toBe(200);

      const getRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.supplier_name_snapshot).toBe(originalName);
      expect(getRes.body.data.supplier_phone_snapshot).toBe(originalPhone);
      expect(getRes.body.data.supplier_email_snapshot).toBe(originalEmail);
    });
  });

  it("isolates purchase orders across businesses (404, not a data leak)", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
    const { po } = await createDraftPo();

    const getRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${otherLogin.accessToken}`);
    expect(getRes.status).toBe(404);

    const listRes = await request(app).get("/purchase-orders").set("Authorization", `Bearer ${otherLogin.accessToken}`);
    expect(listRes.body.data.every((p: { id: string }) => p.id !== po.id)).toBe(true);
  });
});
