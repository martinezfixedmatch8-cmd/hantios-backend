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
import { domainEvents } from "../src/lib/events";

describe("PO Secure Link", () => {
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
    const product = await createTestProduct(businessId, { costPrice: 10 });

    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 5, unitCostSnapshot: 10 }] });
    const po = createRes.body.data;

    const sendRes = await request(app)
      .post(`/purchase-orders/${po.id}/send`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version });

    return { po: sendRes.body.data, supplier, product };
  }

  describe("RBAC", () => {
    const cases: { role: UserRole; canWrite: boolean }[] = [
      { role: "owner", canWrite: true },
      { role: "manager", canWrite: true },
      { role: "accountant", canWrite: false },
      { role: "storekeeper", canWrite: false },
      { role: "cashier", canWrite: false },
      { role: "shareholder", canWrite: false },
      { role: "custom", canWrite: false },
      { role: "super_admin", canWrite: true },
    ];

    it.each(cases)("role=$role write=$canWrite", async ({ role, canWrite }) => {
      const { po } = await createSentPo();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey());
      expect(res.status).toBe(canWrite ? 201 : 403);
    });
  });

  it("returns 401 with no token", async () => {
    const { po } = await createSentPo();
    const res = await request(app).post(`/purchase-orders/${po.id}/secure-link/regenerate`);
    expect(res.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const { po } = await createSentPo();
    const res = await request(app).post(`/purchase-orders/${po.id}/secure-link/regenerate`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it("generates a link, returns the raw token URL exactly once, and never persists the raw token", async () => {
    const { po } = await createSentPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey());

    expect(res.status).toBe(201);
    expect(res.body.data.url).toMatch(/\/po\/[a-f0-9]+$/);
    expect(res.body.data.status).toBe("active");
    expect(res.body.data.view_count).toBe(0);

    const rawToken = res.body.data.url.split("/po/")[1];
    const dbRow = await prisma.po_secure_links.findUnique({ where: { id: res.body.data.id } });
    // The raw token must never equal the stored hash, and the stored hash
    // must not contain the raw token as a substring.
    expect(dbRow?.token_hash).not.toBe(rawToken);
    expect(dbRow?.token_hash).not.toContain(rawToken);

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: res.body.data.id, action: "purchase_order.secure_link_generated" } });
    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows[0])).not.toContain(rawToken);
  });

  it("regenerating revokes the prior active link (one PO = one active link)", async () => {
    const { po } = await createSentPo();
    const first = await request(app)
      .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey());
    const second = await request(app)
      .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey());

    expect(second.status).toBe(201);
    const firstRow = await prisma.po_secure_links.findUnique({ where: { id: first.body.data.id } });
    expect(firstRow?.status).toBe("revoked");
    const secondRow = await prisma.po_secure_links.findUnique({ where: { id: second.body.data.id } });
    expect(secondRow?.status).toBe("active");
  });

  it("revokes an active link", async () => {
    const { po } = await createSentPo();
    const genRes = await request(app)
      .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey());

    const revokeRes = await request(app)
      .post(`/purchase-orders/${po.id}/secure-link/revoke`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey());
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.data.status).toBe("revoked");

    const row = await prisma.po_secure_links.findUnique({ where: { id: genRes.body.data.id } });
    expect(row?.status).toBe("revoked");
  });

  it("returns 400 revoking when no active link exists", async () => {
    const { po } = await createSentPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/secure-link/revoke`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey());
    expect(res.status).toBe(400);
  });

  it("rejects generating a link against a draft (not yet sent) purchase order", async () => {
    const supplier = await createTestSupplier(businessId);
    const product = await createTestProduct(businessId);
    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 1, unitCostSnapshot: 5 }] });

    const res = await request(app)
      .post(`/purchase-orders/${createRes.body.data.id}/secure-link/regenerate`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey());
    expect(res.status).toBe(400);
  });

  describe("Supplier portal view", () => {
    it("views the PO via the token, updates view_count/last_viewed_at, and fires the first-view event only once", async () => {
      const { po } = await createSentPo();
      const genRes = await request(app)
        .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey());
      const rawToken = genRes.body.data.url.split("/po/")[1];

      let firstViewCount = 0;
      const listener = () => {
        firstViewCount += 1;
      };
      domainEvents.on("PurchaseOrderViewedBySupplier", listener);

      const view1 = await request(app).get(`/portal/po/${rawToken}`);
      expect(view1.status).toBe(200);
      expect(view1.body.data.id).toBe(po.id);
      expect(view1.body.data.purchase_order_items).toBeDefined();

      const view2 = await request(app).get(`/portal/po/${rawToken}`);
      expect(view2.status).toBe(200);

      domainEvents.off("PurchaseOrderViewedBySupplier", listener);
      expect(firstViewCount).toBe(1);

      const row = await prisma.po_secure_links.findUnique({ where: { id: genRes.body.data.id } });
      expect(row?.view_count).toBe(2);
      expect(row?.last_viewed_at).not.toBeNull();
    });

    it("returns 404 for a nonexistent token", async () => {
      const res = await request(app).get("/portal/po/deadbeefdeadbeefdeadbeefdeadbeef");
      expect(res.status).toBe(404);
    });

    it("returns 410 for a revoked link", async () => {
      const { po } = await createSentPo();
      const genRes = await request(app)
        .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey());
      const rawToken = genRes.body.data.url.split("/po/")[1];

      await request(app)
        .post(`/purchase-orders/${po.id}/secure-link/revoke`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey());

      const res = await request(app).get(`/portal/po/${rawToken}`);
      expect(res.status).toBe(410);
    });

    it("auto-expires the link once the PO is confirmed (terminal negotiation state)", async () => {
      const { po } = await createSentPo();
      const genRes = await request(app)
        .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey());
      const rawToken = genRes.body.data.url.split("/po/")[1];

      await request(app)
        .post(`/purchase-orders/${po.id}/confirm`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });

      const row = await prisma.po_secure_links.findUnique({ where: { id: genRes.body.data.id } });
      expect(row?.status).toBe("expired");

      const res = await request(app).get(`/portal/po/${rawToken}`);
      expect(res.status).toBe(410);
    });
  });

  it("isolates secure links across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createSentPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/secure-link/regenerate`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey());
    expect(res.status).toBe(404);
  });
});
