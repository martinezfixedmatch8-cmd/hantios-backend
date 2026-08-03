import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestBranch, createTestProduct, createTestSupplier } from "./helpers/factories";
import type { UserRole } from "@prisma/client";

describe("PO Negotiation Internal Notes", () => {
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

  describe("RBAC -- Owner/Manager ONLY, stricter than the general view bar (no accountant)", () => {
    const cases: { role: UserRole; canAccess: boolean }[] = [
      { role: "owner", canAccess: true },
      { role: "manager", canAccess: true },
      { role: "accountant", canAccess: false },
      { role: "storekeeper", canAccess: false },
      { role: "cashier", canAccess: false },
      { role: "shareholder", canAccess: false },
      { role: "custom", canAccess: false },
      { role: "super_admin", canAccess: true },
    ];

    it.each(cases)("role=$role access=$canAccess", async ({ role, canAccess }) => {
      const { po } = await createSentPoWithLink();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const createRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/internal-notes`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ noteText: "Supplier seems flexible on price" });
      expect(createRes.status).toBe(canAccess ? 201 : 403);

      const listRes = await request(app).get(`/purchase-orders/${po.id}/negotiation/internal-notes`).set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canAccess ? 200 : 403);
    });
  });

  it("creates and lists a note, stamping created_by", async () => {
    const { po } = await createSentPoWithLink();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/internal-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ noteText: "Internal-only observation" });
    expect(res.status).toBe(201);
    expect(res.body.data.note_text).toBe("Internal-only observation");
    expect(res.body.data.created_by).toBeTruthy();

    const listRes = await request(app).get(`/purchase-orders/${po.id}/negotiation/internal-notes`).set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
  });

  it("is never exposed on any supplier-portal route (no such route exists)", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/internal-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ noteText: "Confidential margin analysis" });

    // The supplier's own full-PO view must never include internal notes --
    // po_negotiation_internal_notes has no relation on purchase_orders'
    // own include shape, and the portal router defines no
    // /portal/po/:token/internal-notes route at all (404, not a 403 --
    // there is nothing here to authorize, the route itself doesn't exist).
    const viewRes = await request(app).get(`/portal/po/${rawToken}`);
    expect(viewRes.status).toBe(200);
    expect(JSON.stringify(viewRes.body)).not.toContain("Confidential margin analysis");

    const attemptRes = await request(app).get(`/portal/po/${rawToken}/internal-notes`);
    expect(attemptRes.status).toBe(404);
  });

  it("isolates internal notes across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createSentPoWithLink();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/internal-notes`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ noteText: "Hijack attempt" });
    expect(res.status).toBe(404);
  });
});
