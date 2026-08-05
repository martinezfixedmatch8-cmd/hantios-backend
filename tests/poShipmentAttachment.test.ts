import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestBranch, createTestProduct, createTestSupplier } from "./helpers/factories";
import type { UserRole } from "@prisma/client";

describe("PO Shipment Attachments", () => {
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

  async function createShipment() {
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
    const po = fullPoRes.body.data;
    const poItemId = po.purchase_order_items[0].id;
    const shipmentRes = await request(app)
      .post(`/purchase-orders/${po.id}/shipments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ method: "sea", items: [{ poItemId, quantityShipped: 10 }] });
    return { po, shipment: shipmentRes.body.data };
  }

  const validAttachment = { type: "bill_of_lading", fileName: "bol.pdf", mimeType: "application/pdf", fileSizeBytes: 1024, storageKey: "test-key-1" };

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
      const { po, shipment } = await createShipment();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const createRes = await request(app)
        .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/attachments`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send(validAttachment);
      expect(createRes.status).toBe(canWrite ? 201 : 403);

      const listRes = await request(app)
        .get(`/purchase-orders/${po.id}/shipments/${shipment.id}/attachments`)
        .set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);
    });
  });

  it("round-trips a real attachment via StorageProvider (create -> list -> matches)", async () => {
    const { po, shipment } = await createShipment();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/attachments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(validAttachment);
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("bill_of_lading");
    expect(res.body.data.storage_key).toBe("test-key-1");

    const listRes = await request(app)
      .get(`/purchase-orders/${po.id}/shipments/${shipment.id}/attachments`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].id).toBe(res.body.data.id);
  });

  it("`type` is client-chosen, independent of mimeType (unlike PO Negotiation Attachments)", async () => {
    const { po, shipment } = await createShipment();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/attachments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ ...validAttachment, type: "certificate_of_origin" }); // same PDF mimeType, different document role
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("certificate_of_origin");
  });

  it("400s an invalid attachment type", async () => {
    const { po, shipment } = await createShipment();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/attachments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ ...validAttachment, type: "not_a_real_type" });
    expect(res.status).toBe(400);
  });

  it("400s an oversized file (> 10MB)", async () => {
    const { po, shipment } = await createShipment();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/attachments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ ...validAttachment, fileSizeBytes: 10 * 1024 * 1024 + 1 });
    expect(res.status).toBe(400);
  });

  it("isolates attachments across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po, shipment } = await createShipment();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/attachments`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send(validAttachment);
    expect(res.status).toBe(404);
  });

  it("audit-logs the attachment upload", async () => {
    const { po, shipment } = await createShipment();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/attachments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(validAttachment);

    const auditRows = await prisma.audit_logs.findMany({
      where: { entity_id: res.body.data.id, action: "purchase_order.shipment_attachment_uploaded" },
    });
    expect(auditRows).toHaveLength(1);
  });
});
