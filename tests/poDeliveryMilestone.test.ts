import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestBranch, createTestProduct, createTestSupplier } from "./helpers/factories";
import type { UserRole } from "@prisma/client";
import { domainEvents } from "../src/lib/events";

describe("PO Delivery Milestones", () => {
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

  async function createSentPo() {
    const supplier = await createTestSupplier(businessId);
    const product = await createTestProduct(businessId);
    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 10, unitCostSnapshot: 10 }] });
    const sendRes = await request(app)
      .post(`/purchase-orders/${createRes.body.data.id}/send`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: createRes.body.data.version });
    // send's own response body doesn't include purchase_order_items (only
    // create/update/get do) -- re-fetch via GET for the full shape.
    const fullPoRes = await request(app).get(`/purchase-orders/${sendRes.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
    return { po: fullPoRes.body.data };
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
      const { po } = await createSentPo();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const createRes = await request(app)
        .post(`/purchase-orders/${po.id}/delivery-milestones`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ milestone: "production_started" });
      expect(createRes.status).toBe(canWrite ? 201 : 403);

      const listRes = await request(app).get(`/purchase-orders/${po.id}/delivery-milestones`).set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);
    });
  });

  it("records a PO-level milestone (no shipmentId) and derives recordedFrom from the actor, never from client input", async () => {
    const { po } = await createSentPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/delivery-milestones`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      // Deliberately attempts to claim recordedFrom: "supplier" via the
      // (undocumented-as-trusted) body field -- must be ignored, always
      // derived from the actual calling actor.
      .send({ milestone: "production_started", recordedFrom: "supplier" });
    expect(res.status).toBe(201);
    expect(res.body.data.recorded_from).toBe("owner");
    expect(res.body.data.shipment_id).toBeNull();
  });

  it("does not hard-block out-of-order milestones, but includes a warning", async () => {
    const { po } = await createSentPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/delivery-milestones`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ milestone: "arrived" }); // no production_started/shipped ever recorded
    expect(res.status).toBe(201);
    expect(res.body.data.warning).toBeDefined();
  });

  it("no warning when milestones are recorded in the typical order", async () => {
    const { po } = await createSentPo();
    await request(app)
      .post(`/purchase-orders/${po.id}/delivery-milestones`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ milestone: "production_started" });
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/delivery-milestones`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ milestone: "production_finished" });
    expect(res.body.data.warning).toBeUndefined();
  });

  it("associates a milestone with a specific shipment when shipmentId is given", async () => {
    const { po } = await createSentPo();
    const poItemId = po.purchase_order_items[0].id;
    const shipmentRes = await request(app)
      .post(`/purchase-orders/${po.id}/shipments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ method: "sea", items: [{ poItemId, quantityShipped: 10 }] });

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/delivery-milestones`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ milestone: "shipped", shipmentId: shipmentRes.body.data.id });
    expect(res.status).toBe(201);
    expect(res.body.data.shipment_id).toBe(shipmentRes.body.data.id);
  });

  it("404s a milestone referencing a shipment from a different PO", async () => {
    const { po: po1 } = await createSentPo();
    const { po: po2 } = await createSentPo();
    const poItemId2 = po2.purchase_order_items[0].id;
    const shipment2 = await request(app)
      .post(`/purchase-orders/${po2.id}/shipments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ method: "sea", items: [{ poItemId: poItemId2, quantityShipped: 10 }] });

    const res = await request(app)
      .post(`/purchase-orders/${po1.id}/delivery-milestones`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ milestone: "shipped", shipmentId: shipment2.body.data.id });
    expect(res.status).toBe(404);
  });

  it("never triggers or duplicates GRN creation -- recording warehouse_received/completed leaves goods_received_notes untouched", async () => {
    const { po } = await createSentPo();
    const grnCountBefore = await prisma.goods_received_notes.count({ where: { purchase_order_id: po.id } });

    await request(app)
      .post(`/purchase-orders/${po.id}/delivery-milestones`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ milestone: "warehouse_received" });
    await request(app)
      .post(`/purchase-orders/${po.id}/delivery-milestones`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ milestone: "completed" });

    const grnCountAfter = await prisma.goods_received_notes.count({ where: { purchase_order_id: po.id } });
    expect(grnCountAfter).toBe(grnCountBefore);
  });

  it("publishes PurchaseOrderDeliveryMilestoneRecorded", async () => {
    const { po } = await createSentPo();
    const events: unknown[] = [];
    const listener = (payload: unknown) => events.push(payload);
    domainEvents.on("PurchaseOrderDeliveryMilestoneRecorded", listener);

    await request(app)
      .post(`/purchase-orders/${po.id}/delivery-milestones`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ milestone: "packing" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toHaveLength(1);
    domainEvents.off("PurchaseOrderDeliveryMilestoneRecorded", listener);
  });

  it("isolates milestones across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createSentPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/delivery-milestones`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ milestone: "production_started" });
    expect(res.status).toBe(404);
  });
});
