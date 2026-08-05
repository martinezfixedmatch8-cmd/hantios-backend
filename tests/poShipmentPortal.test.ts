import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestBranch, createTestProduct, createTestSupplier } from "./helpers/factories";

describe("PO Shipments -- supplier portal", () => {
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

  async function createSentPoWithLink() {
    const supplier = await createTestSupplier(businessId);
    const product = await createTestProduct(businessId, { costPrice: 10 });
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
    const po = fullPoRes.body.data;

    const genRes = await request(app)
      .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey());
    const rawToken = genRes.body.data.url.split("/po/")[1];

    return { po, supplier, rawToken };
  }

  it("supplier creates a shipment with items via the portal, recordedFrom/createdByParty derived as supplier", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    const poItemId = po.purchase_order_items[0].id;

    const res = await request(app)
      .post(`/portal/po/${rawToken}/shipments`)
      .set("Idempotency-Key", idemKey())
      .send({
        senderName: "Ahmed Hassan",
        senderPhone: "+254712345678",
        method: "sea",
        items: [{ poItemId, quantityShipped: 10 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.created_by_party).toBe("supplier");
    expect(res.body.data.created_by_name).toBe("Ahmed Hassan");

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: res.body.data.id, action: "purchase_order.shipment_created" } });
    expect(auditRows).toHaveLength(1);
    // audit_logs.user_id is a real FK -- supplier actions resolve to the
    // PO's created_by, never a literal "supplier" string, same rule as
    // every other po_negotiation_* action.
    expect(auditRows[0].user_id).toBe(po.created_by);
    expect(auditRows[0].user_name).toContain("Ahmed Hassan");
  });

  it("owner can view a supplier-created shipment; supplier can view via the portal list", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    const poItemId = po.purchase_order_items[0].id;
    await request(app)
      .post(`/portal/po/${rawToken}/shipments`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Ahmed", senderPhone: "+254712345678", method: "air", items: [{ poItemId, quantityShipped: 10 }] });

    const ownerListRes = await request(app).get(`/purchase-orders/${po.id}/shipments`).set("Authorization", `Bearer ${ownerToken}`);
    expect(ownerListRes.body.data).toHaveLength(1);

    const portalListRes = await request(app).get(`/portal/po/${rawToken}/shipments`);
    expect(portalListRes.status).toBe(200);
    expect(portalListRes.body.data).toHaveLength(1);
  });

  it("supplier updates the ETA window via the portal", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    const poItemId = po.purchase_order_items[0].id;
    const shipmentRes = await request(app)
      .post(`/portal/po/${rawToken}/shipments`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Ahmed", senderPhone: "+254712345678", method: "sea", items: [{ poItemId, quantityShipped: 10 }] });

    const newFrom = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .post(`/portal/po/${rawToken}/shipments/${shipmentRes.body.data.id}/eta`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Ahmed", senderPhone: "+254712345678", newExpectedArrivalFrom: newFrom, reasonCategory: "carrier_delay", reason: "Vessel delayed at origin port" });
    expect(res.status).toBe(200);
    expect(new Date(res.body.data.expected_arrival_from).toISOString()).toBe(newFrom);

    const etaUpdates = await prisma.po_eta_updates.findMany({ where: { shipment_id: shipmentRes.body.data.id } });
    expect(etaUpdates).toHaveLength(1);
    expect(etaUpdates[0].updated_by_party).toBe("supplier");
  });

  it("supplier uploads a shipment attachment via the portal", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    const poItemId = po.purchase_order_items[0].id;
    const shipmentRes = await request(app)
      .post(`/portal/po/${rawToken}/shipments`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Ahmed", senderPhone: "+254712345678", method: "sea", items: [{ poItemId, quantityShipped: 10 }] });

    const res = await request(app)
      .post(`/portal/po/${rawToken}/shipments/${shipmentRes.body.data.id}/attachments`)
      .set("Idempotency-Key", idemKey())
      .send({
        senderName: "Ahmed",
        senderPhone: "+254712345678",
        type: "packing_list",
        fileName: "packing.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 512,
        storageKey: "supplier-key-1",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.uploaded_by_party).toBe("supplier");
  });

  it("supplier records a delivery milestone via the portal", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    void po;
    const res = await request(app)
      .post(`/portal/po/${rawToken}/delivery-milestones`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Ahmed", senderPhone: "+254712345678", milestone: "ready_to_ship" });
    expect(res.status).toBe(201);
    expect(res.body.data.recorded_from).toBe("supplier");
    expect(res.body.data.recorded_by_name).toBe("Ahmed");

    const listRes = await request(app).get(`/portal/po/${rawToken}/delivery-milestones`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
  });

  it("has no status-transition route on the portal -- shipment status stays owner-only", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    const poItemId = po.purchase_order_items[0].id;
    const shipmentRes = await request(app)
      .post(`/portal/po/${rawToken}/shipments`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Ahmed", senderPhone: "+254712345678", method: "sea", items: [{ poItemId, quantityShipped: 10 }] });

    const res = await request(app)
      .patch(`/portal/po/${rawToken}/shipments/${shipmentRes.body.data.id}/status`)
      .set("Idempotency-Key", idemKey())
      .send({ version: shipmentRes.body.data.version, status: "dispatched" });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid phone number", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    const poItemId = po.purchase_order_items[0].id;
    const res = await request(app)
      .post(`/portal/po/${rawToken}/shipments`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Test", senderPhone: "not-a-phone", method: "sea", items: [{ poItemId, quantityShipped: 10 }] });
    expect(res.status).toBe(400);
  });
});
