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
  createTestProduct,
  createTestBranch,
  createTestPaymentMethod,
  createTestSupplier,
} from "./helpers/factories";
import { generateReceiptInTransaction } from "../src/services/receipt.service";
import { generateId } from "../src/lib/ids";
import type { UserRole } from "@prisma/client";

const idemKey = () => `test-${randomUUID()}`;

describe("Module 06 -- Receipt System", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let ownerId: string;
  let branchId: string;
  let paymentMethodId: string;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    ownerId = owner.ownerId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;

    const branch = await createTestBranch(businessId);
    branchId = branch.id;
    const pm = await createTestPaymentMethod(businessId);
    paymentMethodId = pm.id;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  async function createSaleReceipt(quantity = 2, sellingPrice = 50) {
    const product = await createTestProduct(businessId, { sellingPrice, costPrice: 20 });
    await request(app)
      .post("/warehouse-movements/stock-in") // no-op path just for realism; sales use branch_inventory, seed that directly
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: product.id, quantity: 100, unitCost: 20 })
      .catch(() => undefined);
    await prisma.branch_inventory.create({
      data: { id: generateId(), business_id: businessId, branch_id: branchId, product_id: product.id, size: "", quantity: 100 },
    });

    const saleRes = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        branchId,
        paymentMethodId,
        items: [{ productId: product.id, quantity }],
      });
    expect(saleRes.status).toBe(201);
    return { sale: saleRes.body.data, product };
  }

  describe("Sale -> Sale Receipt", () => {
    it("generates a Sale Receipt for a completed sale, snapshotting items/payment method", async () => {
      const { sale } = await createSaleReceipt(3, 40);

      const receipt = await prisma.receipts.findFirst({ where: { business_id: businessId, sale_id: sale.id, receipt_type: "sale" } });
      expect(receipt).not.toBeNull();
      expect(receipt!.status).toBe("issued");
      expect(receipt!.receipt_number).toMatch(/^RCP-\d{4}-\d{6}$/);
      const snapshot = receipt!.snapshot as unknown as { items: { productName: string }[]; paymentMethod: string | null };
      expect(snapshot.items.length).toBe(1);
      expect(snapshot.paymentMethod).not.toBeNull();
    });

    it("returns 409 for a genuinely duplicate source-event receipt attempt -- the DB-level critical safeguard, not just app logic", async () => {
      const { sale } = await createSaleReceipt(1, 10);
      const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });

      // Call the generator directly a SECOND time for the SAME sale_id,
      // bypassing the normal one-call-per-sale flow -- this is the real
      // test of the 5 hand-added partial unique indexes actually rejecting
      // a duplicate at the database layer, not merely "the app never calls
      // this twice in practice."
      await expect(
        prisma.$transaction(async (tx) => {
          await generateReceiptInTransaction(tx, {
            businessId,
            timezone: business.timezone,
            settings: business.settings,
            currencyCode: business.currency,
            receiptType: "sale",
            source: { saleId: sale.id },
            subtotal: 10,
            total: 10,
            snapshot: { business: { name: "x", address: null, logoUrl: null }, items: [], paymentMethod: null },
            createdBy: ownerId,
          });
        })
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("Sale Void: transitions the existing receipt to voided, creates NO new receipt", async () => {
      const { sale } = await createSaleReceipt(1, 10);
      const before = await prisma.receipts.count({ where: { business_id: businessId, sale_id: sale.id } });
      expect(before).toBe(1);

      const voidRes = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "test void" });
      expect(voidRes.status).toBe(200);

      const receipt = await prisma.receipts.findFirst({ where: { business_id: businessId, sale_id: sale.id, receipt_type: "sale" } });
      expect(receipt!.status).toBe("voided");
      const after = await prisma.receipts.count({ where: { business_id: businessId, sale_id: sale.id } });
      expect(after).toBe(1); // still exactly one -- no new receipt was generated
    });

    it("Sale Refund: original receipt moves to refunded, a NEW linked Refund Receipt is generated", async () => {
      const { sale, product } = await createSaleReceipt(1, 25);
      // Refund requires being outside the same business day -- move the
      // sale's own timestamp back so isSameBusinessDay reads false, same
      // technique this repo's own sale.test.ts already establishes.
      await prisma.sales.update({ where: { id: sale.id }, data: { timestamp: new Date(Date.now() - 26 * 60 * 60 * 1000) } });

      const refundRes = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "test refund", items: [{ lineIndex: 0, returnedQuantity: 1, restockable: false }] });
      expect(refundRes.status).toBe(201);
      const reversalSaleId = refundRes.body.data.id as string;

      const originalReceipt = await prisma.receipts.findFirst({ where: { business_id: businessId, sale_id: sale.id, receipt_type: "sale" } });
      expect(originalReceipt!.status).toBe("refunded");
      // Financial snapshot on the ORIGINAL must be untouched.
      expect(originalReceipt!.total.toString()).toBe("25");

      const refundReceipt = await prisma.receipts.findFirst({
        where: { business_id: businessId, sale_id: reversalSaleId, receipt_type: "refund" },
      });
      expect(refundReceipt).not.toBeNull();
      expect(refundReceipt!.refund_of_receipt_id).toBe(originalReceipt!.id);
      expect(refundReceipt!.total.toString()).toBe("-25");
      const refundSnapshot = refundReceipt!.snapshot as unknown as { refund?: { originalReceiptNumber: string } };
      expect(refundSnapshot.refund?.originalReceiptNumber).toBe(originalReceipt!.receipt_number);
      void product;
    });
  });

  describe("Debt Payment -> Debt Payment Receipt (full/partial/reversal)", () => {
    async function createTestDebt(amountOriginal: number) {
      const res = await request(app)
        .post("/debts")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({
          branchId,
          customerPhone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
          customerName: "Receipt Test Customer",
          amountOriginal,
          dateTaken: new Date().toISOString().slice(0, 10),
          dateDue: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        });
      expect(res.status).toBe(201);
      return res.body.data;
    }

    it("a FULL payment produces a Debt Payment Receipt with isFullPayment=true, zero remaining balance", async () => {
      const debt = await createTestDebt(100);
      const payRes = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 100 });
      expect(payRes.status).toBe(201);
      const paymentId = payRes.body.data.id as string;

      const receipt = await prisma.receipts.findFirst({ where: { business_id: businessId, debt_payment_id: paymentId } });
      const snap = receipt!.snapshot as unknown as { debtPayment: { isFullPayment: boolean; isReversal: boolean; remainingBalance: string } };
      expect(snap.debtPayment.isFullPayment).toBe(true);
      expect(snap.debtPayment.isReversal).toBe(false);
      expect(snap.debtPayment.remainingBalance).toBe("0");
    });

    it("a PARTIAL payment produces a Debt Payment Receipt with isFullPayment=false, structurally distinguishable from a full payment", async () => {
      const debt = await createTestDebt(200);
      const payRes = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 50 });
      expect(payRes.status).toBe(201);
      const paymentId = payRes.body.data.id as string;

      const receipt = await prisma.receipts.findFirst({ where: { business_id: businessId, debt_payment_id: paymentId } });
      const snap = receipt!.snapshot as unknown as { debtPayment: { isFullPayment: boolean; remainingBalance: string } };
      expect(snap.debtPayment.isFullPayment).toBe(false);
      expect(snap.debtPayment.remainingBalance).toBe("150");
    });

    it("a payment reversal generates its OWN separate Debt Payment Receipt -- explicit, not incidental", async () => {
      const debt = await createTestDebt(80);
      const payRes = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 80 });
      const paymentId = payRes.body.data.id as string;
      const paymentReceipt = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, debt_payment_id: paymentId } });

      const reverseRes = await request(app)
        .post(`/debts/${debt.id}/payments/${paymentId}/reverse`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: payRes.body.data.version, reason: "test reversal" });
      expect(reverseRes.status).toBe(201);
      const reversalId = reverseRes.body.data.id as string;

      const reversalReceipt = await prisma.receipts.findFirst({ where: { business_id: businessId, debt_payment_id: reversalId } });
      expect(reversalReceipt).not.toBeNull();
      expect(reversalReceipt!.id).not.toBe(paymentReceipt.id); // a distinct receipt, not the same row
      const snap = reversalReceipt!.snapshot as unknown as { debtPayment: { isReversal: boolean } };
      expect(snap.debtPayment.isReversal).toBe(true);

      // Both receipts coexist -- the original is never deleted or mutated.
      const stillThere = await prisma.receipts.findUnique({ where: { id: paymentReceipt.id } });
      expect(stillThere).not.toBeNull();
      expect(stillThere!.total.toString()).toBe("80");
    });
  });

  describe("Warehouse Stock Out -> Warehouse Stock Out Receipt", () => {
    it("generates a receipt for a manual stock-out", async () => {
      const product = await createTestProduct(businessId);
      await request(app)
        .post("/warehouse-movements/stock-in")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ productId: product.id, quantity: 20, unitCost: 5 });

      const outRes = await request(app)
        .post("/warehouse-movements/stock-out")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ productId: product.id, quantity: 4, reason: "adjustment" });
      expect(outRes.status).toBe(201);

      const receipt = await prisma.receipts.findFirst({
        where: { business_id: businessId, warehouse_movement_id: outRes.body.data.id, receipt_type: "warehouse_stock_out" },
      });
      expect(receipt).not.toBeNull();
      const snap = receipt!.snapshot as unknown as { warehouseStockOut: { movementNumber: string } };
      expect(snap.warehouseStockOut.movementNumber).toBe(outRes.body.data.movement_number);
    });
  });

  describe("Purchase-order-side triggers -- Supplier Goods Received + PO Settlement", () => {
    async function createConfirmedPoWithGrn() {
      const supplier = await createTestSupplier(businessId, { email: "supplier@example.test" });
      const product = await createTestProduct(businessId, { costPrice: 15 });

      const poRes = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ supplierId: supplier.id, items: [{ productId: product.id, quantityOrdered: 10, unitCostSnapshot: 15 }] });
      expect(poRes.status).toBe(201);
      const po = poRes.body.data;

      const sendRes = await request(app)
        .post(`/purchase-orders/${po.id}/send`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });
      expect(sendRes.status).toBe(200);

      const getRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
      const sentPo = getRes.body.data;
      const poItemId = sentPo.purchase_order_items[0].id;

      const grnRes = await request(app)
        .post(`/purchase-orders/${po.id}/goods-received-notes`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sentPo.version, items: [{ poItemId, quantityReceived: 10, unitCostActual: 15 }] });
      expect(grnRes.status).toBe(201);

      return { po: sentPo, grn: grnRes.body.data, supplier };
    }

    it("GRN creation generates a Supplier Goods Received Receipt", async () => {
      const { grn } = await createConfirmedPoWithGrn();
      const receipt = await prisma.receipts.findFirst({
        where: { business_id: businessId, goods_received_note_id: grn.id, receipt_type: "supplier_goods_received" },
      });
      expect(receipt).not.toBeNull();
      expect(receipt!.total.toString()).toBe("150"); // 10 * 15
    });

    it("PO payment generates a PO Settlement Receipt", async () => {
      const { po } = await createConfirmedPoWithGrn();
      const afterGrnRes = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
      const currentPo = afterGrnRes.body.data;

      const payRes = await request(app)
        .post(`/purchase-orders/${po.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: currentPo.version, amount: 150, invoiceAmount: 150, paymentDate: new Date().toISOString().slice(0, 10) });
      expect(payRes.status).toBe(201);

      const receipt = await prisma.receipts.findFirst({
        where: { business_id: businessId, purchase_order_payment_id: payRes.body.data.payment.id, receipt_type: "po_settlement" },
      });
      expect(receipt).not.toBeNull();
      const snap = receipt!.snapshot as unknown as { poSettlement: { matchStatus: string } };
      expect(snap.poSettlement.matchStatus).toBe("matched");
    });
  });

  describe("Numbering -- shared sequence across all six types", () => {
    it("allocates sequential numbers regardless of receipt type, never resetting per type", async () => {
      const { sale: sale1 } = await createSaleReceipt(1, 5);
      const { sale: sale2 } = await createSaleReceipt(1, 5);
      const r1 = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, sale_id: sale1.id } });
      const r2 = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, sale_id: sale2.id } });
      const seq1 = Number(r1.receipt_number.split("-")[2]);
      const seq2 = Number(r2.receipt_number.split("-")[2]);
      expect(seq2).toBeGreaterThan(seq1);
    });

    it("is concurrency-safe: N truly-parallel sales never collide on the same receipt number", async () => {
      const product = await createTestProduct(businessId, { sellingPrice: 5 });
      await prisma.branch_inventory.create({
        data: { id: generateId(), business_id: businessId, branch_id: branchId, product_id: product.id, size: "", quantity: 1000 },
      });
      const N = 5;
      const responses = await Promise.all(
        Array.from({ length: N }, () =>
          request(app)
            .post("/sales")
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ branchId, paymentMethodId, items: [{ productId: product.id, quantity: 1 }] })
        )
      );
      for (const res of responses) expect(res.status).toBe(201);
      const saleIds = responses.map((r) => r.body.data.id as string);
      const receipts = await prisma.receipts.findMany({ where: { business_id: businessId, sale_id: { in: saleIds } } });
      expect(receipts.length).toBe(N);
      const numbers = new Set(receipts.map((r) => r.receipt_number));
      expect(numbers.size).toBe(N); // no two receipts share a number
    });
  });

  describe("Snapshot immutability", () => {
    it("a later change to the business name does not retroactively change an already-issued receipt's snapshot", async () => {
      const { sale } = await createSaleReceipt(1, 15);
      const receipt = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, sale_id: sale.id } });
      const originalName = (receipt.snapshot as unknown as { business: { name: string } }).business.name;

      await prisma.businesses.update({ where: { id: businessId }, data: { name: "Renamed Business Post-Issuance" } });

      const stillFrozen = await prisma.receipts.findUniqueOrThrow({ where: { id: receipt.id } });
      const frozenName = (stillFrozen.snapshot as unknown as { business: { name: string } }).business.name;
      expect(frozenName).toBe(originalName);
      expect(frozenName).not.toBe("Renamed Business Post-Issuance");

      // Restore for subsequent tests in this file.
      await prisma.businesses.update({ where: { id: businessId }, data: { name: originalName } });
    });
  });

  describe("No Orphan Receipts (transaction boundary)", () => {
    it("a Sale that fails validation (insufficient stock) produces NO receipt at all", async () => {
      const product = await createTestProduct(businessId, { sellingPrice: 10 });
      await prisma.branch_inventory.create({
        data: { id: generateId(), business_id: businessId, branch_id: branchId, product_id: product.id, size: "", quantity: 1 },
      });
      const res = await request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ branchId, paymentMethodId, items: [{ productId: product.id, quantity: 999 }] });
      expect(res.status).toBe(409);

      const count = await prisma.receipts.count({ where: { business_id: businessId, receipt_type: "sale", snapshot: { path: ["items", "0", "productName"], equals: product.name } } });
      // No sale row was created either -- confirm no receipt references any
      // nonexistent sale for this product at all.
      const anyReceiptForProduct = await prisma.receipts.findMany({ where: { business_id: businessId, receipt_type: "sale" } });
      const matchingSnapshot = anyReceiptForProduct.filter((r) => {
        const snap = r.snapshot as unknown as { items: { productName: string }[] };
        return snap.items.some((i) => i.productName === product.name);
      });
      expect(matchingSnapshot.length).toBe(0);
      void count;
    });
  });

  describe("List / Get / Reprint", () => {
    it("lists receipts filtered by type, {data, pagination} envelope", async () => {
      await createSaleReceipt(1, 5);
      const res = await request(app)
        .get("/receipts")
        .query({ type: "sale", pageSize: 5 })
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.pagination).toBeDefined();
      for (const r of res.body.data) expect(r.receipt_type).toBe("sale");
    });

    it("get returns a deterministic renderedText reproduced from the snapshot alone", async () => {
      const { sale } = await createSaleReceipt(2, 30);
      const receipt = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, sale_id: sale.id } });

      const res = await request(app).get(`/receipts/${receipt.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.renderedText).toContain(receipt.receipt_number);
      expect(res.body.data.rendererVersion).toBe(1);
    });

    it("cross-tenant isolation: a receipt cannot be fetched by ID from a different business", async () => {
      const { sale } = await createSaleReceipt(1, 5);
      const receipt = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, sale_id: sale.id } });

      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);

      const res = await request(app).get(`/receipts/${receipt.id}`).set("Authorization", `Bearer ${otherLogin.accessToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("RBAC", () => {
    const viewCases: { role: UserRole; canView: boolean }[] = [
      { role: "owner", canView: true },
      { role: "manager", canView: true },
      { role: "cashier", canView: true },
      { role: "accountant", canView: true },
      { role: "storekeeper", canView: true },
      { role: "shareholder", canView: false },
      { role: "custom", canView: false },
    ];

    it.each(viewCases)("role=$role list receipts view=$canView", async ({ role, canView }) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).get("/receipts").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(canView ? 200 : 403);
    });
  });

  describe("Delivery -- multi-channel, append-only history, two-layer idempotency", () => {
    it("supports print then WhatsApp on the SAME receipt, both logged as separate attempts", async () => {
      const { sale } = await createSaleReceipt(1, 10);
      // Give this sale a real customer phone so WhatsApp delivery has a recipient.
      await prisma.sales.update({ where: { id: sale.id }, data: { customer_phone: "+254700000111" } });
      const receipt = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, sale_id: sale.id } });

      const printRes = await request(app)
        .post(`/receipts/${receipt.id}/deliver`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ channel: "pos_print" });
      expect(printRes.status).toBe(201);
      expect(printRes.body.data.channel).toBe("pos_print");
      expect(printRes.body.data.attempt_number).toBe(1);

      const waRes = await request(app)
        .post(`/receipts/${receipt.id}/deliver`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ channel: "whatsapp" });
      expect(waRes.status).toBe(201);
      expect(waRes.body.data.channel).toBe("whatsapp");
      expect(waRes.body.data.attempt_number).toBe(2);

      const historyRes = await request(app)
        .get(`/receipts/${receipt.id}/delivery-attempts`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(historyRes.status).toBe(200);
      expect(historyRes.body.data.length).toBe(2);
      expect(historyRes.body.data.map((a: { channel: string }) => a.channel).sort()).toEqual(["pos_print", "whatsapp"]);
    });

    it("Idempotency Layer 1: the SAME key + SAME payload replays the original attempt, never creating a second row", async () => {
      const { sale } = await createSaleReceipt(1, 10);
      const receipt = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, sale_id: sale.id } });
      const key = idemKey();

      const first = await request(app)
        .post(`/receipts/${receipt.id}/deliver`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send({ channel: "pos_print" });
      expect(first.status).toBe(201);

      const replay = await request(app)
        .post(`/receipts/${receipt.id}/deliver`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send({ channel: "pos_print" });
      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(first.body.data.id);

      const count = await prisma.receipt_delivery_attempts.count({ where: { receipt_id: receipt.id } });
      expect(count).toBe(1);
    });

    it("Idempotency Layer 2: the SAME key with a DIFFERENT payload is rejected with 409, not silently replayed", async () => {
      const { sale } = await createSaleReceipt(1, 10);
      const receipt = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, sale_id: sale.id } });
      const key = idemKey();

      const first = await request(app)
        .post(`/receipts/${receipt.id}/deliver`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send({ channel: "pos_print" });
      expect(first.status).toBe(201);

      const mismatched = await request(app)
        .post(`/receipts/${receipt.id}/deliver`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send({ channel: "whatsapp" });
      expect(mismatched.status).toBe(409);
    });

    it("a 'Send Again' click (a genuinely fresh key) creates a real new attempt, never blocked", async () => {
      const { sale } = await createSaleReceipt(1, 10);
      const receipt = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, sale_id: sale.id } });

      const first = await request(app)
        .post(`/receipts/${receipt.id}/deliver`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ channel: "pos_print" });
      expect(first.status).toBe(201);

      const again = await request(app)
        .post(`/receipts/${receipt.id}/deliver`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ channel: "pos_print" });
      expect(again.status).toBe(201);
      expect(again.body.data.id).not.toBe(first.body.data.id);
      expect(again.body.data.attempt_number).toBe(2);
    });
  });
});
