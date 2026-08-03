import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestBranch, createTestProduct, createTestSupplier } from "./helpers/factories";

describe("PO Negotiation Attachments", () => {
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

  const validAttachment = {
    fileName: "invoice.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 1024,
    storageKey: "test-storage-key-1",
  };

  describe("Standalone attachment endpoint -- messages", () => {
    it("owner attaches a file to a message", async () => {
      const { po } = await createSentPoWithLink();
      const message = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/messages`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ messageText: "See attached" });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/attachments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ ...validAttachment, messageId: message.body.data.id });
      expect(res.status).toBe(201);
      expect(res.body.data.type).toBe("pdf");
      expect(res.body.data.message_id).toBe(message.body.data.id);
      expect(res.body.data.proposal_id).toBeNull();

      const listRes = await request(app)
        .get(`/purchase-orders/${po.id}/negotiation/messages`)
        .set("Authorization", `Bearer ${ownerToken}`);
      const listedMessage = listRes.body.data.find((m: { id: string }) => m.id === message.body.data.id);
      expect(listedMessage.attachments).toHaveLength(1);
    });

    it("supplier attaches a file to a message via the portal", async () => {
      const { po, rawToken } = await createSentPoWithLink();
      const message = await request(app)
        .post(`/portal/po/${rawToken}/messages`)
        .set("Idempotency-Key", idemKey())
        .send({ senderName: "Ahmed", senderPhone: "+254712345678", messageText: "See attached invoice" });

      const res = await request(app)
        .post(`/portal/po/${rawToken}/attachments`)
        .set("Idempotency-Key", idemKey())
        .send({ ...validAttachment, messageId: message.body.data.id, senderName: "Ahmed", senderPhone: "+254712345678" });
      expect(res.status).toBe(201);
      expect(res.body.data.uploaded_by).toBe("supplier");
      void po;
    });
  });

  describe("XOR validation", () => {
    it("400s when neither messageId nor proposalId is provided", async () => {
      const { po } = await createSentPoWithLink();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/attachments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ ...validAttachment });
      expect(res.status).toBe(400);
    });

    it("400s when BOTH messageId and proposalId are provided", async () => {
      const { po } = await createSentPoWithLink();
      const message = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/messages`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ messageText: "Hi" });

      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
      const draft = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "7" }] });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/attachments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ ...validAttachment, messageId: message.body.data.id, proposalId: draft.body.data.id });
      expect(res.status).toBe(400);
    });
  });

  describe("Size/type rejection", () => {
    it("400s an oversized file (> 10MB)", async () => {
      const { po } = await createSentPoWithLink();
      const message = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/messages`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ messageText: "Hi" });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/attachments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ ...validAttachment, messageId: message.body.data.id, fileSizeBytes: 10 * 1024 * 1024 + 1 });
      expect(res.status).toBe(400);
    });

    it("400s an unsupported mime type", async () => {
      const { po } = await createSentPoWithLink();
      const message = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/messages`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ messageText: "Hi" });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/attachments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ ...validAttachment, messageId: message.body.data.id, mimeType: "application/x-executable" });
      expect(res.status).toBe(400);
    });
  });

  describe("Proposal attachments -- standalone (draft only) and inline (Enhancement #2)", () => {
    it("allows attaching to a still-draft proposal via the standalone endpoint", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
      const draft = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "7" }] });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/attachments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ ...validAttachment, proposalId: draft.body.data.id });
      expect(res.status).toBe(201);
    });

    it("400s attaching to a proposal that is no longer a draft (pending/accepted/rejected)", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
      const draft = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "7" }] });
      await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${draft.body.data.id}/submit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: draft.body.data.version });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/attachments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ ...validAttachment, proposalId: draft.body.data.id });
      expect(res.status).toBe(400);
    });

    it("accepts attachments inline on the draft-save request itself (one submission, per Enhancement #2)", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
      const draft = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({
          comment: "See attached quote",
          changes: [{ fieldChanged: "unit_price", itemId: item.id, newValue: "11" }],
          attachments: [validAttachment],
        });
      expect(draft.status).toBe(200);
      expect(draft.body.data.attachments).toHaveLength(1);
      expect(draft.body.data.attachments[0].file_name).toBe("invoice.pdf");

      // full-replace on a subsequent save: sending zero attachments clears
      // the previously attached one, same as the changes full-replace.
      const updated = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: draft.body.data.version, changes: [{ fieldChanged: "unit_price", itemId: item.id, newValue: "11" }] });
      expect(updated.body.data.attachments).toHaveLength(0);
    });
  });

  it("isolates attachments across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createSentPoWithLink();
    const message = await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/messages`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ messageText: "Hi" });

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/attachments`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ ...validAttachment, messageId: message.body.data.id });
    expect(res.status).toBe(404);
  });
});
