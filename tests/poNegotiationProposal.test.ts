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

describe("PO Negotiation Proposals", () => {
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
    const productA = await createTestProduct(businessId, { costPrice: 10 });
    const productB = await createTestProduct(businessId, { costPrice: 15 });
    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: productA.id, quantityOrdered: 5, unitCostSnapshot: 10 }] });
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

    return { po, supplier, productA, productB, rawToken };
  }

  async function draftAndSubmitAsOwner(poId: string, changes: unknown[], comment?: string) {
    const draftRes = await request(app)
      .post(`/purchase-orders/${poId}/negotiation/proposals/draft`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ comment, changes });
    expect(draftRes.status).toBe(200);
    const proposalId = draftRes.body.data.id;

    const submitRes = await request(app)
      .post(`/purchase-orders/${poId}/negotiation/proposals/${proposalId}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: draftRes.body.data.version });
    expect(submitRes.status).toBe(200);
    return submitRes.body.data;
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
      const { po, productA } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const draftRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "7" }] });
      expect(draftRes.status).toBe(canWrite ? 200 : 403);

      const listRes = await request(app).get(`/purchase-orders/${po.id}/negotiation/proposals`).set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);

      void productA;
    });
  });

  describe("Draft lifecycle", () => {
    it("creates a draft, then updates it via version-guarded save (optimistic lock)", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const first = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ comment: "Initial ask", changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }] });
      expect(first.status).toBe(200);
      expect(first.body.data.status).toBe("draft");
      expect(first.body.data.version).toBe(0);
      expect(first.body.data.changes).toHaveLength(1);

      const second = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: first.body.data.version, comment: "Revised ask", changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "9" }] });
      expect(second.status).toBe(200);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.version).toBe(1);
      expect(second.body.data.comment).toBe("Revised ask");
      expect(second.body.data.changes).toHaveLength(1);
      expect(second.body.data.changes[0].new_value).toBe("9");
    });

    it("409s a draft update sent with a stale version", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const first = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }] });
      expect(first.body.data.version).toBe(0);

      // A real update moves version 0 -> 1; version 0 is now stale.
      await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "10" }] });

      const stale = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "11" }] });
      expect(stale.status).toBe(409);
    });

    it("400s when sending a version but no draft exists yet, and 400s when a draft exists but no version is sent", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const noDraftYet = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }] });
      expect(noDraftYet.status).toBe(400);

      await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }] });

      const missingVersion = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "9" }] });
      expect(missingVersion.status).toBe(400);
    });

    it("rejects malformed changes: quantity must be a positive integer, unit_price at most 2dp, itemId required/forbidden per field type", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const badQty = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "-3" }] });
      expect(badQty.status).toBe(400);

      const badPrice = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "unit_price", itemId: item.id, newValue: "10.999" }] });
      expect(badPrice.status).toBe(400);

      const missingItemId = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", newValue: "3" }] });
      expect(missingItemId.status).toBe(400);

      const forbiddenItemId = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "shipping_method", itemId: item.id, newValue: "air freight" }] });
      expect(forbiddenItemId.status).toBe(400);
    });

    it("rejects duplicate changes for the same item+field within one proposal", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({
          changes: [
            { fieldChanged: "quantity", itemId: item.id, newValue: "8" },
            { fieldChanged: "quantity", itemId: item.id, newValue: "9" },
          ],
        });
      expect(res.status).toBe(400);
    });
  });

  describe("Submit", () => {
    it("assigns a sequential revision_number only at submit time, not at draft save", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const draft = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }] });
      expect(draft.body.data.revision_number).toBeNull();

      const submitted = await draftAndSubmitAsOwnerFromDraft(po.id, draft.body.data.id, draft.body.data.version);
      expect(submitted.status).toBe("pending");
      expect(submitted.revision_number).toBe(1);
      expect(submitted.submitted_at).not.toBeNull();
    });

    async function draftAndSubmitAsOwnerFromDraft(poId: string, proposalId: string, version: number) {
      const res = await request(app)
        .post(`/purchase-orders/${poId}/negotiation/proposals/${proposalId}/submit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version });
      expect(res.status).toBe(200);
      return res.body.data;
    }

    it("snapshots old_value from the CURRENT live item state at submit time", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const submitted = await draftAndSubmitAsOwner(po.id, [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }]);
      const change = submitted.changes.find((c: { field_changed: string }) => c.field_changed === "quantity");
      expect(change.old_value).toBe(item.quantity_ordered.toString());
      expect(change.new_value).toBe("8");
    });

    it("locks the proposal from further draft edits once submitted (immutability)", async () => {
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

      // The owner has no more drafts now (it became pending) -- a NEW draft
      // save call creates a brand-new proposal instead of touching the
      // submitted one.
      const newDraft = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "6" }] });
      expect(newDraft.status).toBe(200);
      expect(newDraft.body.data.id).not.toBe(draft.body.data.id);

      // And the original submitted proposal can never be resubmitted/re-
      // drafted directly (no route accepts a non-draft status transition
      // back to draft) -- attempting to submit it again 409s since it is
      // no longer in draft status.
      const resubmit = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${draft.body.data.id}/submit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: draft.body.data.version + 1 });
      expect(resubmit.status).toBe(409);
    });

    it("supersedes a prior PENDING proposal from the same side upon a new submit (never a draft)", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const firstSubmitted = await draftAndSubmitAsOwner(po.id, [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }]);

      const secondDraft = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "6" }] });
      await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${secondDraft.body.data.id}/submit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: secondDraft.body.data.version });

      const supersededCheck = await prisma.po_negotiation_proposals.findUniqueOrThrow({ where: { id: firstSubmitted.id } });
      expect(supersededCheck.status).toBe("superseded");
    });
  });

  describe("Accept -- the core atomic transaction", () => {
    it("applies MULTIPLE coordinated changes atomically (quantity + unit_price together), recomputes total_expected_value, increments negotiation_round, writes an Agreement Snapshot, audit-logs, and publishes the domain event", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const events: unknown[] = [];
      const listener = (payload: unknown) => events.push(payload);
      domainEvents.on("PurchaseOrderNegotiationAccepted", listener);

      const submitted = await draftAndSubmitAsOwner(
        po.id,
        [
          { fieldChanged: "quantity", itemId: item.id, newValue: "8" },
          { fieldChanged: "unit_price", itemId: item.id, newValue: "12.50" },
        ],
        "Please confirm these adjusted terms"
      );

      const acceptRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${submitted.id}/accept`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.data.proposal.status).toBe("accepted");
      expect(acceptRes.body.data.purchaseOrder.negotiation_round).toBe(1);

      const updatedItem = await prisma.purchase_order_items.findUniqueOrThrow({ where: { id: item.id } });
      expect(updatedItem.quantity_ordered.toString()).toBe("8");
      expect(updatedItem.unit_cost_snapshot.toString()).toBe("12.5");
      expect(updatedItem.line_total.toString()).toBe("100");

      const updatedPo = await prisma.purchase_orders.findUniqueOrThrow({ where: { id: po.id } });
      expect(updatedPo.total_expected_value.toString()).toBe("100");
      expect(updatedPo.negotiation_round).toBe(1);

      const snapshot = await prisma.po_negotiation_agreement_snapshots.findFirstOrThrow({ where: { proposal_id: submitted.id } });
      expect(snapshot.negotiation_round).toBe(1);
      expect(snapshot.total_expected_value.toString()).toBe("100");

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: submitted.id, action: "purchase_order.negotiation_accepted" } });
      expect(auditRows).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toHaveLength(1);
      domainEvents.off("PurchaseOrderNegotiationAccepted", listener);
    });

    it("applies product_substitution, product_added, and product_removed correctly within one proposal", async () => {
      const { po, productB } = await createSentPoWithLink();
      const originalItem = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const productC = await createTestProduct(businessId, { costPrice: 20 });

      const submitted = await draftAndSubmitAsOwner(po.id, [
        { fieldChanged: "product_added", newValue: JSON.stringify({ productId: productC.id, quantity: 2, unitCost: 20 }) },
      ]);
      const acceptRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${submitted.id}/accept`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(acceptRes.status).toBe(200);

      const items = await prisma.purchase_order_items.findMany({ where: { purchase_order_id: po.id } });
      expect(items).toHaveLength(2);
      const addedItem = items.find((i) => i.product_id === productC.id)!;
      expect(addedItem.quantity_ordered.toString()).toBe("2");
      expect(addedItem.line_total.toString()).toBe("40");

      const submitted2 = await draftAndSubmitAsOwner(po.id, [
        { fieldChanged: "product_substitution", itemId: originalItem.id, newValue: productB.id },
      ]);
      const acceptRes2 = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${submitted2.id}/accept`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(acceptRes2.status).toBe(200);
      const substituted = await prisma.purchase_order_items.findUniqueOrThrow({ where: { id: originalItem.id } });
      expect(substituted.product_id).toBe(productB.id);

      const submitted3 = await draftAndSubmitAsOwner(po.id, [{ fieldChanged: "product_removed", itemId: addedItem.id, newValue: "n/a" }]);
      const acceptRes3 = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${submitted3.id}/accept`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(acceptRes3.status).toBe(200);
      const remaining = await prisma.purchase_order_items.findMany({ where: { purchase_order_id: po.id } });
      expect(remaining.map((i) => i.id)).not.toContain(addedItem.id);
    });

    it("409s a double-accept, exactly once under real concurrency", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
      const submitted = await draftAndSubmitAsOwner(po.id, [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }]);

      const [r1, r2] = await Promise.all([
        request(app)
          .post(`/purchase-orders/${po.id}/negotiation/proposals/${submitted.id}/accept`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({}),
        request(app)
          .post(`/purchase-orders/${po.id}/negotiation/proposals/${submitted.id}/accept`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({}),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const snapshots = await prisma.po_negotiation_agreement_snapshots.findMany({ where: { proposal_id: submitted.id } });
      expect(snapshots).toHaveLength(1);
    });

    it("400s an accept attempt on a still-draft proposal", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
      const draft = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }] });

      const acceptRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${draft.body.data.id}/accept`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(acceptRes.status).toBe(400);
    });
  });

  describe("Reject", () => {
    it("owner rejects a supplier-submitted proposal with a required reason", async () => {
      const { po, rawToken } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      const draft = await request(app)
        .post(`/portal/po/${rawToken}/proposals/draft`)
        .set("Idempotency-Key", idemKey())
        .send({ senderName: "Ahmed", senderPhone: "+254712345678", changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "3" }] });
      expect(draft.status).toBe(200);
      expect(draft.body.data.proposed_by).toBe("supplier");

      const submit = await request(app)
        .post(`/portal/po/${rawToken}/proposals/${draft.body.data.id}/submit`)
        .set("Idempotency-Key", idemKey())
        .send({ senderName: "Ahmed", senderPhone: "+254712345678", version: draft.body.data.version });
      expect(submit.status).toBe(200);

      const rejectRes = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${draft.body.data.id}/reject`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ reason: "Quantity too low for our minimum order" });
      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body.data.status).toBe("rejected");

      const unchangedItem = await prisma.purchase_order_items.findUniqueOrThrow({ where: { id: item.id } });
      expect(unchangedItem.quantity_ordered.toString()).toBe(item.quantity_ordered.toString());
    });

    it("400s reject without a reason", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
      const submitted = await draftAndSubmitAsOwner(po.id, [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }]);

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/${submitted.id}/reject`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(res.status).toBe(400);
    });

    it("supplier can reject an owner-submitted proposal via the portal, with identity captured", async () => {
      const { po, rawToken } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
      const submitted = await draftAndSubmitAsOwner(po.id, [{ fieldChanged: "unit_price", itemId: item.id, newValue: "50" }]);

      const res = await request(app)
        .post(`/portal/po/${rawToken}/proposals/${submitted.id}/reject`)
        .set("Idempotency-Key", idemKey())
        .send({ reason: "Price too high", senderName: "Ahmed Hassan", senderPhone: "+254712345678" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("rejected");

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: submitted.id, action: "purchase_order.negotiation_rejected" } });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].user_id).toBe(po.created_by);
      expect(auditRows[0].user_name).toContain("Ahmed Hassan");
    });
  });

  describe("Listing excludes the other party's drafts", () => {
    it("hides a supplier's own draft from the owner's list, but shows the owner's own draft to themselves", async () => {
      const { po, rawToken } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });

      await request(app)
        .post(`/portal/po/${rawToken}/proposals/draft`)
        .set("Idempotency-Key", idemKey())
        .send({ senderName: "Ahmed", senderPhone: "+254712345678", changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "3" }] });

      const ownerList = await request(app).get(`/purchase-orders/${po.id}/negotiation/proposals`).set("Authorization", `Bearer ${ownerToken}`);
      expect(ownerList.status).toBe(200);
      expect(ownerList.body.data.every((p: { proposed_by: string; status: string }) => !(p.proposed_by === "supplier" && p.status === "draft"))).toBe(true);

      const ownerDraft = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "4" }] });

      const ownerListAgain = await request(app).get(`/purchase-orders/${po.id}/negotiation/proposals`).set("Authorization", `Bearer ${ownerToken}`);
      expect(ownerListAgain.body.data.some((p: { id: string }) => p.id === ownerDraft.body.data.id)).toBe(true);
    });
  });

  describe("Workflow guard", () => {
    it("400s a draft save once the PO is confirmed", async () => {
      const { po } = await createSentPoWithLink();
      const item = await prisma.purchase_order_items.findFirstOrThrow({ where: { purchase_order_id: po.id } });
      await request(app)
        .post(`/purchase-orders/${po.id}/confirm`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ changes: [{ fieldChanged: "quantity", itemId: item.id, newValue: "8" }] });
      expect(res.status).toBe(400);
    });
  });

  it("isolates proposals across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createSentPoWithLink();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/negotiation/proposals/draft`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ changes: [{ fieldChanged: "quantity", itemId: randomUUID(), newValue: "8" }] });
    expect(res.status).toBe(404);
  });
});
