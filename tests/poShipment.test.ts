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

describe("PO Shipments, Tracking, Delivery Milestones, ETA", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerId: string;
  let ownerToken: string;
  let branchId: string;

  const idemKey = () => `test-${randomUUID()}`;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    ownerId = owner.ownerId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;
    const branch = await createTestBranch(businessId);
    branchId = branch.id;
  });

  // signAccessToken's own default expiry is 15 minutes -- this file's own
  // cumulative runtime can exceed that on a slower database branch
  // (observed: 943.9s on an isolated test branch), which would otherwise
  // make createSentPo()'s own POST /purchase-orders call start returning a
  // real 401 partway through the file once ownerToken silently expired.
  // Re-minting fresh before every single test -- via the same
  // no-HTTP-round-trip mintAccessToken synthesis this file's own RBAC
  // block already uses for every other role -- keeps ownerToken always
  // valid regardless of how long the file has already been running.
  beforeEach(async () => {
    const owner = await prisma.users.findUniqueOrThrow({ where: { id: ownerId } });
    ownerToken = mintAccessToken(owner);
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  async function createSentPo(quantity = 10, costPrice = 10) {
    const supplier = await createTestSupplier(businessId);
    const product = await createTestProduct(businessId, { costPrice });
    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: quantity, unitCostSnapshot: costPrice }] });
    const sendRes = await request(app)
      .post(`/purchase-orders/${createRes.body.data.id}/send`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: createRes.body.data.version });
    const fullPoRes = await request(app).get(`/purchase-orders/${sendRes.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
    return { po: fullPoRes.body.data, supplier, product };
  }

  async function createShipment(poId: string, poItemId: string, quantityShipped: number, overrides: Record<string, unknown> = {}) {
    return request(app)
      .post(`/purchase-orders/${poId}/shipments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ method: "sea", items: [{ poItemId, quantityShipped }], ...overrides });
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
      const poItemId = po.purchase_order_items[0].id;
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const createRes = await request(app)
        .post(`/purchase-orders/${po.id}/shipments`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ method: "sea", items: [{ poItemId, quantityShipped: 5 }] });
      expect(createRes.status).toBe(canWrite ? 201 : 403);

      const listRes = await request(app).get(`/purchase-orders/${po.id}/shipments`).set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);
    });
  });

  describe("Creation", () => {
    it("creates a shipment with a year-scoped shipment number and its own first status-history row", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const res = await createShipment(po.id, poItemId, 5);
      expect(res.status).toBe(201);
      expect(res.body.data.shipment_number).toMatch(/^SHP-\d{4}-\d{6}$/);
      expect(res.body.data.status).toBe("pending");
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].quantity_shipped).toBe("5");

      const history = await prisma.po_shipment_status_history.findMany({ where: { shipment_id: res.body.data.id } });
      expect(history).toHaveLength(1);
      expect(history[0].from_status).toBeNull();
      expect(history[0].to_status).toBe("pending");
      expect(history[0].changed_by_party).toBe("owner");
    });

    it("400s creating a shipment against a DRAFT purchase order", async () => {
      const supplier = await createTestSupplier(businessId);
      const product = await createTestProduct(businessId);
      const createRes = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 5, unitCostSnapshot: 10 }] });

      const res = await createShipment(createRes.body.data.id, createRes.body.data.purchase_order_items[0].id, 5);
      expect(res.status).toBe(400);
    });

    it("snapshots delivery_address_snapshot from the PO's own branch", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const res = await createShipment(po.id, poItemId, 5);
      expect(res.body.data.delivery_address_snapshot.source).toBe("branch");
      expect(res.body.data.delivery_address_snapshot.branchId).toBe(branchId);
    });

    it("rejects duplicate poItemId within one shipment request", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/shipments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ method: "air", items: [{ poItemId, quantityShipped: 3 }, { poItemId, quantityShipped: 2 }] });
      expect(res.status).toBe(400);
    });

    it("400s an invalid method value", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/shipments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ method: "truck", items: [{ poItemId, quantityShipped: 5 }] });
      expect(res.status).toBe(400);
    });
  });

  describe("Incoterms + cost-responsibility suggestion", () => {
    it("rejects an invalid Incoterm value", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const res = await createShipment(po.id, poItemId, 5, { incoterms: "NOTREAL" });
      expect(res.status).toBe(400);
    });

    it("accepts all 11 real Incoterm values", async () => {
      const allIncoterms = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];
      for (const incoterm of allIncoterms) {
        const { po } = await createSentPo();
        const poItemId = po.purchase_order_items[0].id;
        const res = await createShipment(po.id, poItemId, 5, { incoterms: incoterm });
        expect(res.status).toBe(201);
        expect(res.body.data.incoterms).toBe(incoterm);
      }
    }, 120000);

    it("suggests BUYER cost/insurance responsibility for EXW when not explicitly overridden", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const res = await createShipment(po.id, poItemId, 5, { incoterms: "EXW" });
      expect(res.body.data.cost_responsibility).toBe("buyer");
      expect(res.body.data.insurance_responsibility).toBe("buyer");
    });

    it("suggests SUPPLIER cost/insurance responsibility for FOB/CIF/DAP when not explicitly overridden", async () => {
      for (const incoterm of ["FOB", "CIF", "DAP"]) {
        const { po } = await createSentPo();
        const poItemId = po.purchase_order_items[0].id;
        const res = await createShipment(po.id, poItemId, 5, { incoterms: incoterm });
        expect(res.body.data.cost_responsibility).toBe("supplier");
      }
    }, 60000);

    it("an explicit costResponsibility always wins over the incoterm-based suggestion", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const res = await createShipment(po.id, poItemId, 5, { incoterms: "EXW", costResponsibility: "shared" });
      expect(res.body.data.cost_responsibility).toBe("shared");
    });

    it("insurance cost and insurance responsibility are tracked as two independent facts", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const res = await createShipment(po.id, poItemId, 5, { insurance: 500, insuranceResponsibility: "supplier" });
      expect(res.body.data.insurance).toBe("500");
      expect(res.body.data.insurance_responsibility).toBe("supplier");
    });
  });

  describe("Partial shipments -- multiple PoShipment rows per PO", () => {
    it("tracks shipped-vs-ordered cumulatively and correctly across two separate shipments", async () => {
      const { po } = await createSentPo(10); // ordered 10
      const poItemId = po.purchase_order_items[0].id;

      const first = await createShipment(po.id, poItemId, 4);
      expect(first.status).toBe(201);

      const remainingAfterFirst = await request(app)
        .get(`/purchase-orders/${po.id}/shipments/${first.body.data.id}/remaining-quantities`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(remainingAfterFirst.body.data.shippingStatus).toBe("PARTIALLY_SHIPPED");
      expect(remainingAfterFirst.body.data.items[0].quantityShipped).toBe("4");
      expect(remainingAfterFirst.body.data.items[0].quantityRemaining).toBe("6");

      const second = await createShipment(po.id, poItemId, 6);
      expect(second.status).toBe(201);

      const remainingAfterSecond = await request(app)
        .get(`/purchase-orders/${po.id}/shipments/${second.body.data.id}/remaining-quantities`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(remainingAfterSecond.body.data.shippingStatus).toBe("FULLY_SHIPPED");
      expect(remainingAfterSecond.body.data.items[0].quantityShipped).toBe("10");
      expect(remainingAfterSecond.body.data.items[0].quantityRemaining).toBe("0");

      const listRes = await request(app).get(`/purchase-orders/${po.id}/shipments`).set("Authorization", `Bearer ${ownerToken}`);
      expect(listRes.body.data).toHaveLength(2);
    });

    it("NO_SHIPMENT before any shipment exists", async () => {
      const { po } = await createSentPo(10);
      const poItemId = po.purchase_order_items[0].id;
      const shipment = await createShipment(po.id, poItemId, 1); // need a shipment row to hit the endpoint's ownership check
      await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.body.data.id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: shipment.body.data.version, status: "cancelled", cancelReason: "supplier_issue" });

      // The only shipment is now cancelled -- cancelled shipments don't
      // count toward cumulative shipped quantity, so this PO should read
      // back as NO_SHIPMENT despite technically having one (cancelled) row.
      const remaining = await request(app)
        .get(`/purchase-orders/${po.id}/shipments/${shipment.body.data.id}/remaining-quantities`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(remaining.body.data.shippingStatus).toBe("NO_SHIPMENT");
    });
  });

  describe("Addendum #22 -- over-shipment is HARD BLOCKED (deliberate divergence from GRN's own allow-and-flag precedent)", () => {
    it("rejects a single shipment exceeding the ordered quantity", async () => {
      const { po } = await createSentPo(10);
      const poItemId = po.purchase_order_items[0].id;
      const res = await createShipment(po.id, poItemId, 15);
      expect(res.status).toBe(400);
    });

    it("rejects a second shipment that would push the cumulative total over the ordered quantity", async () => {
      const { po } = await createSentPo(10);
      const poItemId = po.purchase_order_items[0].id;
      await createShipment(po.id, poItemId, 8);
      const res = await createShipment(po.id, poItemId, 5); // 8+5=13 > 10
      expect(res.status).toBe(400);
    });
  });

  describe("Status transitions -- permissive state machine, terminal immutability", () => {
    it("allows the forward flow: pending -> dispatched -> in_transit -> arrived -> delivered", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      let shipment = (await createShipment(po.id, poItemId, 5)).body.data;

      for (const status of ["dispatched", "in_transit", "arrived", "delivered"]) {
        const res = await request(app)
          .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: shipment.version, status });
        expect(res.status).toBe(200);
        shipment = res.body.data;
      }
      expect(shipment.status).toBe("delivered");
      expect(shipment.received_at).not.toBeNull();

      const history = await prisma.po_shipment_status_history.findMany({ where: { shipment_id: shipment.id }, orderBy: { changed_at: "asc" } });
      expect(history.map((h) => h.to_status)).toEqual(["pending", "dispatched", "in_transit", "arrived", "delivered"]);
    });

    it("blocks a nonsensical backward/skip jump (pending -> arrived)", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
      const res = await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: shipment.version, status: "arrived" });
      expect(res.status).toBe(400);
    });

    it("allows delayed as a re-enterable status (dispatched -> delayed -> in_transit)", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      let shipment = (await createShipment(po.id, poItemId, 5)).body.data;
      for (const status of ["dispatched", "delayed", "in_transit"]) {
        const res = await request(app)
          .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: shipment.version, status });
        expect(res.status).toBe(200);
        shipment = res.body.data;
      }
      expect(shipment.status).toBe("in_transit");
    });

    it("requires cancelReason when cancelling (addendum #18)", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
      const res = await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: shipment.version, status: "cancelled" });
      expect(res.status).toBe(400);
    });

    it("captures cancelReason/cancelReasonNotes on cancellation", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
      const res = await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: shipment.version, status: "cancelled", cancelReason: "port_closure", cancelReasonNotes: "Port shut down for 2 weeks" });
      expect(res.status).toBe(200);
      expect(res.body.data.cancel_reason).toBe("port_closure");
      expect(res.body.data.cancel_reason_notes).toBe("Port shut down for 2 weeks");
    });

    it("captures receivedBy/receivedAt/receiverNotes on delivery (addendum #19)", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      let shipment = (await createShipment(po.id, poItemId, 5)).body.data;
      for (const status of ["dispatched", "in_transit", "arrived"]) {
        shipment = (
          await request(app)
            .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ version: shipment.version, status })
        ).body.data;
      }
      const deliveredRes = await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: shipment.version, status: "delivered", receivedBy: "John Doe (front desk)", receiverNotes: "Signed without issue" });
      expect(deliveredRes.status).toBe(200);
      expect(deliveredRes.body.data.received_by).toBe("John Doe (front desk)");
      expect(deliveredRes.body.data.receiver_notes).toBe("Signed without issue");
      expect(deliveredRes.body.data.received_at).not.toBeNull();
    });

    describe("Addendum #23 -- version lock: immutable once DELIVERED or CANCELLED", () => {
      it("blocks any further status transition once cancelled", async () => {
        const { po } = await createSentPo();
        const poItemId = po.purchase_order_items[0].id;
        const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
        const cancelled = (
          await request(app)
            .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ version: shipment.version, status: "cancelled", cancelReason: "other" })
        ).body.data;

        const res = await request(app)
          .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: cancelled.version, status: "dispatched" });
        expect(res.status).toBe(400);
      });

      it("blocks ETA updates once a shipment reaches a terminal status", async () => {
        const { po } = await createSentPo();
        const poItemId = po.purchase_order_items[0].id;
        const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
        await request(app)
          .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: shipment.version, status: "cancelled", cancelReason: "other" });

        const res = await request(app)
          .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/eta`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ newExpectedArrivalFrom: new Date().toISOString(), reasonCategory: "other", reason: "test" });
        expect(res.status).toBe(400);
      });

      it("still allows attachments after DELIVERED (proof-of-delivery can arrive late), but not after CANCELLED", async () => {
        const { po } = await createSentPo();
        const poItemId = po.purchase_order_items[0].id;
        let shipment = (await createShipment(po.id, poItemId, 5)).body.data;
        for (const status of ["dispatched", "in_transit", "arrived", "delivered"]) {
          shipment = (
            await request(app)
              .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
              .set("Authorization", `Bearer ${ownerToken}`)
              .set("Idempotency-Key", idemKey())
              .send({ version: shipment.version, status })
          ).body.data;
        }
        const attachAfterDelivered = await request(app)
          .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/attachments`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ type: "bill_of_lading", fileName: "pod.pdf", mimeType: "application/pdf", fileSizeBytes: 1024, storageKey: "key-1" });
        expect(attachAfterDelivered.status).toBe(201);

        const { po: po2 } = await createSentPo();
        const poItemId2 = po2.purchase_order_items[0].id;
        const shipment2 = (await createShipment(po2.id, poItemId2, 5)).body.data;
        await request(app)
          .patch(`/purchase-orders/${po2.id}/shipments/${shipment2.id}/status`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: shipment2.version, status: "cancelled", cancelReason: "other" });

        const attachAfterCancelled = await request(app)
          .post(`/purchase-orders/${po2.id}/shipments/${shipment2.id}/attachments`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ type: "bill_of_lading", fileName: "pod.pdf", mimeType: "application/pdf", fileSizeBytes: 1024, storageKey: "key-2" });
        expect(attachAfterCancelled.status).toBe(400);
      }, 60000);
    });
  });

  describe("ETA updates -- transactional, append-only, window-based (addendum #17)", () => {
    it("always creates a PoEtaUpdate row and updates po_shipments' own window together", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;

      const newFrom = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
      const newTo = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/eta`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ newExpectedArrivalFrom: newFrom, newExpectedArrivalTo: newTo, reasonCategory: "port_congestion", reason: "Port backlog" });
      expect(res.status).toBe(200);
      expect(new Date(res.body.data.expected_arrival_from).toISOString()).toBe(newFrom);
      expect(new Date(res.body.data.expected_arrival_to).toISOString()).toBe(newTo);

      const etaUpdates = await prisma.po_eta_updates.findMany({ where: { shipment_id: shipment.id } });
      expect(etaUpdates).toHaveLength(1);
      expect(etaUpdates[0].reason_category).toBe("port_congestion");
      expect(etaUpdates[0].reason).toBe("Port backlog");
    });

    it("requires both reasonCategory and reason", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/eta`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ newExpectedArrivalFrom: new Date().toISOString() });
      expect(res.status).toBe(400);
    });

    it("publishes PurchaseOrderShipmentEtaChanged", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;

      const events: unknown[] = [];
      const listener = (payload: unknown) => events.push(payload);
      domainEvents.on("PurchaseOrderShipmentEtaChanged", listener);

      await request(app)
        .post(`/purchase-orders/${po.id}/shipments/${shipment.id}/eta`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ newExpectedArrivalFrom: new Date().toISOString(), reasonCategory: "weather", reason: "Storm delay" });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toHaveLength(1);
      domainEvents.off("PurchaseOrderShipmentEtaChanged", listener);
    });
  });

  describe("General shipment update -- PATCH /:id/shipments/:shipmentId (added on second review)", () => {
    it("updates each editable field correctly, with a proper before/after audit trail", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5, { carrier: "DHL", shippingCost: 100 })).body.data;

      const res = await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({
          version: shipment.version,
          carrier: "FedEx",
          trackingReference: "TRK123",
          trackingType: "courier_tracking",
          shippingCost: 150,
          insurance: 20,
          customsCost: 5,
          priority: "urgent",
          reason: "Carrier changed after supplier renegotiated freight terms",
        });
      expect(res.status).toBe(200);
      expect(res.body.data.carrier).toBe("FedEx");
      expect(res.body.data.tracking_reference).toBe("TRK123");
      expect(res.body.data.tracking_type).toBe("courier_tracking");
      expect(res.body.data.shipping_cost).toBe("150");
      expect(res.body.data.insurance).toBe("20");
      expect(res.body.data.customs_cost).toBe("5");
      expect(res.body.data.priority).toBe("urgent");
      expect(res.body.data.version).toBe(shipment.version + 1);

      const auditRows = await prisma.audit_logs.findMany({
        where: { entity_id: shipment.id, action: "purchase_order.shipment_updated" },
      });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].reason).toBe("Carrier changed after supplier renegotiated freight terms");
      const before = auditRows[0].before_state as Record<string, unknown>;
      const after = auditRows[0].after_state as Record<string, unknown>;
      expect(before.carrier).toBe("DHL");
      expect(after.carrier).toBe("FedEx");
      expect(before.shippingCost).toBe("100");
      expect(after.shippingCost).toBe(150);
    });

    it("updates only the fields actually sent, leaving others untouched", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5, { carrier: "DHL", priority: "low" })).body.data;

      const res = await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: shipment.version, priority: "high", reason: "Escalated by customer" });
      expect(res.status).toBe(200);
      expect(res.body.data.priority).toBe("high");
      expect(res.body.data.carrier).toBe("DHL"); // untouched
    });

    it("requires a reason", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
      const res = await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: shipment.version, carrier: "FedEx" });
      expect(res.status).toBe(400);
    });

    it("requires at least one editable field", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
      const res = await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: shipment.version, reason: "no-op attempt" });
      expect(res.status).toBe(400);
    });

    describe("Immutable fields are rejected with 400, never silently ignored", () => {
      const immutableAttempts: Record<string, unknown>[] = [
        { method: "air" },
        { incoterms: "FOB" },
        { portOfDeparture: "Mombasa" },
        { portOfArrival: "Rotterdam" },
        { deliveryAddressSnapshot: { source: "branch", branchId: "x" } },
        { poId: "some-other-id" },
        { items: [{ poItemId: "x", quantityShipped: 1 }] },
      ];

      it.each(immutableAttempts)("rejects an attempt to change %j", async (attempt) => {
        const { po } = await createSentPo();
        const poItemId = po.purchase_order_items[0].id;
        const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
        const res = await request(app)
          .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: shipment.version, reason: "attempting to edit an immutable field", ...attempt });
        expect(res.status).toBe(400);
      });
    });

    it("409s a stale version", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
      const res = await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: shipment.version + 1, carrier: "FedEx", reason: "test" });
      expect(res.status).toBe(409);
    });

    it("409s once the shipment reaches a terminal status (delivered/cancelled) -- same atomic guard as the version check", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;
      const cancelled = (
        await request(app)
          .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: shipment.version, status: "cancelled", cancelReason: "other" })
      ).body.data;

      const res = await request(app)
        .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: cancelled.version, carrier: "FedEx", reason: "test" });
      expect(res.status).toBe(409);
    });

    it("under real concurrency, exactly one of two simultaneous updates succeeds", async () => {
      const { po } = await createSentPo();
      const poItemId = po.purchase_order_items[0].id;
      const shipment = (await createShipment(po.id, poItemId, 5)).body.data;

      const [r1, r2] = await Promise.all([
        request(app)
          .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: shipment.version, carrier: "FedEx", reason: "race A" }),
        request(app)
          .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: shipment.version, carrier: "UPS", reason: "race B" }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const reloaded = await prisma.po_shipments.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(["FedEx", "UPS"]).toContain(reloaded.carrier);
    });
  });

  it("isolates shipments across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createSentPo();
    const poItemId = po.purchase_order_items[0].id;
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/shipments`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ method: "sea", items: [{ poItemId, quantityShipped: 1 }] });
    expect(res.status).toBe(404);
  });
});
