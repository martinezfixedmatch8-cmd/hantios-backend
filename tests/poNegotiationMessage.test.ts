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

describe("PO Negotiation Messages", () => {
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

    return { po, supplier, product, rawToken };
  }

  describe("RBAC (owner side)", () => {
    const cases: { role: UserRole; canWrite: boolean; canView: boolean }[] = [
      { role: "owner", canWrite: true, canView: true },
      { role: "manager", canWrite: true, canView: true },
      { role: "accountant", canWrite: false, canView: true },
      { role: "storekeeper", canWrite: false, canView: false },
      { role: "cashier", canWrite: false, canView: false },
      { role: "shareholder", canWrite: false, canView: false },
      { role: "custom", canWrite: false, canView: false },
      { role: "super_admin", canWrite: true, canView: true },
    ];

    it.each(cases)("role=$role write=$canWrite view=$canView", async ({ role, canWrite, canView }) => {
      const { po } = await createSentPoWithLink();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const createRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/messages`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ messageText: "Hello" });
      expect(createRes.status).toBe(canWrite ? 201 : 403);

      const listRes = await request(app).get(`/purchase-orders/${po.id}/negotiation/messages`).set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);
    });
  });

  it("owner creates a message; supplier views it via the portal", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    const createRes = await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/messages`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ messageText: "Can you confirm the delivery date?" });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.sender_type).toBe("owner");

    const listRes = await request(app).get(`/portal/po/${rawToken}/messages`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.pagination).toBeDefined();
  });

  it("supplier creates a message with senderName/senderPhone captured", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    const res = await request(app)
      .post(`/portal/po/${rawToken}/messages`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Ahmed Hassan", senderPhone: "+254712345678", messageText: "Only 80 units available" });

    expect(res.status).toBe(201);
    expect(res.body.data.sender_type).toBe("supplier");
    expect(res.body.data.sender_name).toBe("Ahmed Hassan");

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: res.body.data.id, action: "purchase_order.negotiation_message_sent" } });
    expect(auditRows).toHaveLength(1);
    // audit_logs.user_id is a real FK -- supplier actions resolve to the
    // PO's created_by, never a literal "supplier" string.
    expect(auditRows[0].user_id).toBe(po.created_by);
    expect(auditRows[0].user_name).toContain("Ahmed Hassan");
  });

  it("rejects a supplier message with an invalid phone number", async () => {
    const { rawToken } = await createSentPoWithLink();
    const res = await request(app)
      .post(`/portal/po/${rawToken}/messages`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Test", senderPhone: "not-a-phone", messageText: "Hi" });
    expect(res.status).toBe(400);
  });

  it("threads a reply via replyToMessageId", async () => {
    const { po, rawToken } = await createSentPoWithLink();
    const first = await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/messages`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ messageText: "Original question" });

    const reply = await request(app)
      .post(`/portal/po/${rawToken}/messages`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Test", senderPhone: "+254712345678", messageText: "Reply", replyToMessageId: first.body.data.id });

    expect(reply.status).toBe(201);
    expect(reply.body.data.reply_to_message_id).toBe(first.body.data.id);
  });

  it("rejects a reply pointing at a message from a different PO", async () => {
    const { rawToken: rawToken1 } = await createSentPoWithLink();
    const { po: po2 } = await createSentPoWithLink();
    const other = await request(app)
      .post(`/purchase-orders/${po2.id}/negotiation/messages`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ messageText: "On a different PO" });

    const res = await request(app)
      .post(`/portal/po/${rawToken1}/messages`)
      .set("Idempotency-Key", idemKey())
      .send({ senderName: "Test", senderPhone: "+254712345678", messageText: "Reply", replyToMessageId: other.body.data.id });
    expect(res.status).toBe(404);
  });

  describe("Read receipts", () => {
    it("sets read_at/read_by once on first read by the OTHER party, never overwritten on subsequent reads", async () => {
      const { po, rawToken } = await createSentPoWithLink();
      const created = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/messages`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ messageText: "Please respond" });
      const messageId = created.body.data.id;

      const firstRead = await request(app).post(`/portal/po/${rawToken}/messages/${messageId}/read`).set("Idempotency-Key", idemKey());
      expect(firstRead.status).toBe(200);
      expect(firstRead.body.data.read_at).not.toBeNull();
      expect(firstRead.body.data.read_by).toBe("supplier");
      const firstReadAt = firstRead.body.data.read_at;

      const secondRead = await request(app).post(`/portal/po/${rawToken}/messages/${messageId}/read`).set("Idempotency-Key", idemKey());
      expect(secondRead.status).toBe(200);
      expect(secondRead.body.data.read_at).toBe(firstReadAt);
    });

    it("the sender reading their own message is a no-op (read_at stays null)", async () => {
      const { po, rawToken } = await createSentPoWithLink();
      const created = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/messages`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ messageText: "Own message" });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/messages/${created.body.data.id}/read`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey());
      expect(res.status).toBe(200);
      expect(res.body.data.read_at).toBeNull();

      void rawToken;
    });
  });

  describe("Workflow Guard", () => {
    it("rejects a new message once the PO is confirmed (negotiation locked)", async () => {
      const { po } = await createSentPoWithLink();
      await request(app)
        .post(`/purchase-orders/${po.id}/confirm`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/messages`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ messageText: "Too late" });
      expect(res.status).toBe(400);
    });
  });

  it("isolates messages across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createSentPoWithLink();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/messages`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ messageText: "Hijack attempt" });
    expect(res.status).toBe(404);
  });
});
