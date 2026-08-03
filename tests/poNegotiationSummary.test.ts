import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestBranch, createTestProduct, createTestSupplier } from "./helpers/factories";

describe("PO Negotiation Summary / Status / Deadline", () => {
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
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 5, unitCostSnapshot: 10 }] });
    const sendRes = await request(app)
      .post(`/purchase-orders/${createRes.body.data.id}/send`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: createRes.body.data.version });
    const po = sendRes.body.data;

    const genRes = await request(app)
      .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey());
    const rawToken = genRes.body.data.url.split("/po/")[1];

    return { po, rawToken };
  }

  it("OPEN when no proposal has been submitted yet", async () => {
    const { po } = await createSentPoWithLink();
    const res = await request(app).get(`/purchase-orders/${po.id}/negotiation`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("OPEN");
    expect(res.body.data.negotiationRound).toBe(0);
    expect(res.body.data.totalSubmittedProposals).toBe(0);
  });

  it("WAITING_SUPPLIER once the owner submits a pending proposal", async () => {
    const { po } = await createSentPoWithLink();
    const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
    const draft = await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }] });
    await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/proposals/${draft.body.data.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: draft.body.data.version });

    const res = await request(app).get(`/purchase-orders/${po.id}/negotiation`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.data.status).toBe("WAITING_SUPPLIER");
    expect(res.body.data.totalSubmittedProposals).toBe(1);
    expect(res.body.data.latestProposal.id).toBe(draft.body.data.id);
  });

  it("WAITING_OWNER once the supplier submits a pending proposal", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
    const draft = await request(app)
      .post(`/portal/po/${rawToken}/proposals/draft`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Ahmed", senderPhone: "+254712345678", changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "3" }] });
    await request(app)
      .post(`/portal/po/${rawToken}/proposals/${draft.body.data.id}/submit`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Ahmed", senderPhone: "+254712345678", version: draft.body.data.version });

    const res = await request(app).get(`/purchase-orders/${po.id}/negotiation`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.data.status).toBe("WAITING_OWNER");

    const portalRes = await request(app).get(`/portal/po/${rawToken}/negotiation`);
    expect(portalRes.status).toBe(200);
    expect(portalRes.body.data.status).toBe("WAITING_OWNER");
  });

  it("AGREED once the PO is confirmed", async () => {
    const { po } = await createSentPoWithLink();
    const confirmRes = await request(app)
      .post(`/purchase-orders/${po.id}/confirm`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version });
    expect(confirmRes.status).toBe(200);

    const res = await request(app).get(`/purchase-orders/${po.id}/negotiation`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.data.status).toBe("AGREED");
  });

  it("REJECTED once the PO is cancelled", async () => {
    const { po } = await createSentPoWithLink();
    const cancelRes = await request(app)
      .post(`/purchase-orders/${po.id}/cancel`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version, reason: "Supplier unable to meet terms" });
    expect(cancelRes.status).toBe(200);

    const res = await request(app).get(`/purchase-orders/${po.id}/negotiation`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.data.status).toBe("REJECTED");
  });

  describe("Deadline", () => {
    it("sets and clears negotiation_respond_by, audit-logged, version-guarded", async () => {
      const { po } = await createSentPoWithLink();
      const respondBy = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const setRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/deadline`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, respondBy });
      expect(setRes.status).toBe(200);
      expect(new Date(setRes.body.data.negotiation_respond_by).toISOString()).toBe(respondBy);

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: po.id, action: "purchase_order.negotiation_deadline_set" } });
      expect(auditRows.length).toBeGreaterThanOrEqual(1);

      const staleRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/deadline`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, respondBy: null });
      expect(staleRes.status).toBe(409);

      const clearRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/deadline`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: setRes.body.data.version, respondBy: null });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.data.negotiation_respond_by).toBeNull();
    });

    it("EXPIRED once negotiation_respond_by is in the past", async () => {
      const { po } = await createSentPoWithLink();
      const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
      const setRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/deadline`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, respondBy: pastDate });
      expect(setRes.status).toBe(200);

      const res = await request(app).get(`/purchase-orders/${po.id}/negotiation`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.body.data.status).toBe("EXPIRED");
    });

    it("RBAC: only owner/manager can set a deadline", async () => {
      const { po } = await createSentPoWithLink();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/deadline`)
        .set("Authorization", `Bearer invalid`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, respondBy: null });
      expect(res.status).toBe(401);
    });
  });

  it("EXPIRED once the secure link itself is revoked", async () => {
    const { po } = await createSentPoWithLink();
    await request(app)
      .post(`/purchase-orders/${po.id}/secure-link/revoke`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey());

    const res = await request(app).get(`/purchase-orders/${po.id}/negotiation`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.data.status).toBe("EXPIRED");
  });

  it("isolates negotiation summaries across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createSentPoWithLink();
    const res = await request(app).get(`/purchase-orders/${po.id}/negotiation`).set("Authorization", `Bearer ${otherLogin.accessToken}`);
    expect(res.status).toBe(404);
  });
});
