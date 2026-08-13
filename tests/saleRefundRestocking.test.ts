import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestProduct, createTestBranch, createTestBranchInventory } from "./helpers/factories";

const idemKey = () => `test-${randomUUID()}`;

describe("Sale Refund, Partial Refund & Inventory Restoration", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let branchId: string;

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

  async function stockedProduct(quantity: number, overrides: Partial<{ costPrice: number; sellingPrice: number }> = {}) {
    const product = await createTestProduct(businessId, overrides);
    await createTestBranchInventory(businessId, branchId, product.id, { quantity });
    return product;
  }

  async function backdateSale(saleId: string, daysAgo = 2) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysAgo);
    await prisma.sales.update({ where: { id: saleId }, data: { timestamp: date } });
    return prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
  }

  // Creates a real backdated (already past-day-close) sale for a single
  // product line, ready for refund.
  async function createRefundableSale(quantity: number, overrides: Partial<{ costPrice: number; sellingPrice: number; stock: number; branch: string }> = {}) {
    const stock = overrides.stock ?? quantity + 10;
    const product = await createTestProduct(businessId, { costPrice: overrides.costPrice, sellingPrice: overrides.sellingPrice });
    await createTestBranchInventory(businessId, overrides.branch ?? branchId, product.id, { quantity: stock });
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId: overrides.branch ?? branchId, items: [{ productId: product.id, quantity }] });
    expect(res.status).toBe(201);
    const sale = await backdateSale(res.body.data.id);
    return { sale, product };
  }

  async function refund(saleId: string, version: number, items: Record<string, unknown>[], reason = "test refund") {
    return request(app)
      .post(`/sales/${saleId}/refund`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version, reason, items });
  }

  async function stockOf(productId: string, branch = branchId) {
    const row = await prisma.branch_inventory.findFirst({ where: { branch_id: branch, product_id: productId } });
    return Number(row?.quantity ?? 0);
  }

  // Test 1 -- full resellable refund
  it("Test 1: full resellable refund restores the full quantity to inventory", async () => {
    const { sale, product } = await createRefundableSale(2, { stock: 10 });
    expect(await stockOf(product.id)).toBe(8);

    const res = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: true }]);
    expect(res.status).toBe(201);
    expect(await stockOf(product.id)).toBe(10);

    const saleRefund = await prisma.sale_refunds.findFirstOrThrow({ where: { sale_id: sale.id } });
    const items = await prisma.sale_refund_items.findMany({ where: { sale_refund_id: saleRefund.id } });
    expect(Number(items[0].restockable_quantity)).toBe(2);
    expect(Number(items[0].write_off_quantity)).toBe(0);
  });

  // Test 2 -- full non-resellable refund
  it("Test 2: full non-resellable refund performs no inventory restoration (pure write-off)", async () => {
    const { sale, product } = await createRefundableSale(2, { stock: 10 });
    expect(await stockOf(product.id)).toBe(8);

    const res = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: false }]);
    expect(res.status).toBe(201);
    expect(await stockOf(product.id)).toBe(8); // unchanged

    const restockRows = await prisma.inventory_adjustments.findMany({ where: { sale_id: sale.id, adjustment_type: "refund_restock" } });
    expect(restockRows).toHaveLength(0);
  });

  // Test 3 -- mixed refund
  it("Test 3: mixed refund restocks only the resellable portion, write-off derived correctly", async () => {
    const { sale, product } = await createRefundableSale(5, { stock: 10 });
    expect(await stockOf(product.id)).toBe(5);

    const res = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 5, restockableQuantity: 3 }]);
    expect(res.status).toBe(201);
    expect(await stockOf(product.id)).toBe(8); // 5 + 3

    const saleRefund = await prisma.sale_refunds.findFirstOrThrow({ where: { sale_id: sale.id } });
    const items = await prisma.sale_refund_items.findMany({ where: { sale_refund_id: saleRefund.id } });
    expect(Number(items[0].returned_quantity)).toBe(5);
    expect(Number(items[0].restockable_quantity)).toBe(3);
    expect(Number(items[0].write_off_quantity)).toBe(2);
  });

  // Test 4/5 -- partial refund, then a second partial refund exhausting it
  it("Tests 4-5: multiple partial refund events track remaining quantity correctly, sale ends fully refunded", async () => {
    const { sale, product } = await createRefundableSale(2, { stock: 10 });

    const first = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: true }]);
    expect(first.status).toBe(201);
    const afterFirst = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    expect(afterFirst.status).toBe("partially_refunded");

    const second = await refund(sale.id, afterFirst.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: true }]);
    expect(second.status).toBe(201);
    const afterSecond = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    expect(afterSecond.status).toBe("refunded"); // terminal, fully exhausted

    expect(await stockOf(product.id)).toBe(10); // both units restocked

    const reversals = await prisma.sales.findMany({ where: { refund_of_sale_id: sale.id } });
    expect(reversals).toHaveLength(2); // one reversal row per refund EVENT
  });

  // Test 6 -- over-refund prevention (single request exceeding remaining)
  it("Test 6: rejects a refund request exceeding the remaining refundable quantity", async () => {
    const { sale } = await createRefundableSale(2, { stock: 10 });

    const first = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: false }]);
    expect(first.status).toBe(201);
    const afterFirst = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });

    // Remaining = 1, requesting 2 -- must be rejected.
    const second = await refund(sale.id, afterFirst.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: false }]);
    expect(second.status).toBe(400);
  });

  // Test 7 -- a third refund attempt once quantity is fully exhausted. Once
  // EVERY line is fully returned, the sale itself reaches the terminal
  // `refunded` status -- a further attempt is a Final State Protection
  // conflict (409), the exact same shape Void/Refund already use elsewhere
  // in this repo for "already in a terminal state," not a per-line
  // over-refund validation error (400, reserved for a sale that's still
  // genuinely eligible -- see the companion test right below).
  it("Test 7: rejects a further refund attempt once the sale is fully exhausted (terminal state, 409)", async () => {
    const { sale } = await createRefundableSale(2, { stock: 10 });

    const first = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: false }]);
    const afterFirst = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    const second = await refund(sale.id, afterFirst.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: false }]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const afterSecond = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    expect(afterSecond.status).toBe("refunded");

    const third = await refund(sale.id, afterSecond.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: false }]);
    expect(third.status).toBe(409); // sale is already in its terminal state
  });

  // The genuine 400 over-refund path: a still-eligible (partially_refunded,
  // not terminal) sale where one SPECIFIC line has no quantity left, while
  // another line on the same sale is still untouched.
  it("rejects a specific line's over-refund with 400 while the sale itself remains genuinely eligible (a different line still open)", async () => {
    const rice = await createTestProduct(businessId, { costPrice: 5, sellingPrice: 10 });
    const sugar = await createTestProduct(businessId, { costPrice: 3, sellingPrice: 6 });
    await createTestBranchInventory(businessId, branchId, rice.id, { quantity: 10 });
    await createTestBranchInventory(businessId, branchId, sugar.id, { quantity: 10 });
    const saleRes = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: rice.id, quantity: 2 }, { productId: sugar.id, quantity: 2 }] });
    expect(saleRes.status).toBe(201);
    const sale = await backdateSale(saleRes.body.data.id);

    // Fully refund the Rice line (lineIndex 0) only -- Sugar (lineIndex 1)
    // stays completely untouched, so the sale is still partially_refunded,
    // not terminal.
    const first = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: false }]);
    expect(first.status).toBe(201);
    const afterFirst = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    expect(afterFirst.status).toBe("partially_refunded");

    // Rice's own remaining is now 0, but the SALE is still eligible overall
    // (Sugar is open) -- this must reach the real per-line remaining-
    // quantity check and fail there with a genuine 400, not a state conflict.
    const overRefundRice = await refund(sale.id, afterFirst.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: false }]);
    expect(overRefundRice.status).toBe(400);

    // Sugar is still fully refundable.
    const sugarRefund = await refund(sale.id, afterFirst.version, [{ lineIndex: 1, returnedQuantity: 2, restockable: false }]);
    expect(sugarRefund.status).toBe(201);
  });

  // Test 8 -- mixed restock/write-off split across multiple refund visits
  it("Test 8: mixed restock/write-off tracked correctly across two separate refund visits", async () => {
    const { sale, product } = await createRefundableSale(5, { stock: 10 });

    const visit1 = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockableQuantity: 2 }]);
    expect(visit1.status).toBe(201);
    const afterVisit1 = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    expect(afterVisit1.status).toBe("partially_refunded");

    const visit2 = await refund(sale.id, afterVisit1.version, [{ lineIndex: 0, returnedQuantity: 3, restockableQuantity: 1 }]);
    expect(visit2.status).toBe(201);
    const afterVisit2 = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    expect(afterVisit2.status).toBe("refunded"); // 2 + 3 = 5, fully exhausted

    // Total restocked = 2 + 1 = 3 -> stock = 5 (post-sale) + 3 = 8
    expect(await stockOf(product.id)).toBe(8);

    const saleRefunds = await prisma.sale_refunds.findMany({ where: { sale_id: sale.id }, include: { sale_refund_items: true } });
    expect(saleRefunds).toHaveLength(2);
    const allItems = saleRefunds.flatMap((r) => r.sale_refund_items);
    const totalReturned = allItems.reduce((sum, i) => sum + Number(i.returned_quantity), 0);
    const totalRestocked = allItems.reduce((sum, i) => sum + Number(i.restockable_quantity), 0);
    const totalWrittenOff = allItems.reduce((sum, i) => sum + Number(i.write_off_quantity), 0);
    expect(totalReturned).toBe(5);
    expect(totalRestocked).toBe(3);
    expect(totalWrittenOff).toBe(2);
  });

  // Test 9 -- original cost snapshot, never the current product cost
  it("Test 9: restock uses the item's original cost snapshot, never the product's current cost", async () => {
    const { sale, product } = await createRefundableSale(2, { costPrice: 6, sellingPrice: 8, stock: 10 });

    // Product's cost changes AFTER the sale.
    await prisma.products.update({ where: { id: product.id }, data: { cost_price: 7 } });

    const res = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: true }]);
    expect(res.status).toBe(201);

    const saleRefund = await prisma.sale_refunds.findFirstOrThrow({ where: { sale_id: sale.id } });
    const items = await prisma.sale_refund_items.findMany({ where: { sale_refund_id: saleRefund.id } });
    expect(Number(items[0].unit_cost_snapshot)).toBe(6); // the ORIGINAL cost, not the current $7
  });

  // Test 10 -- branch correctness
  it("Test 10: restocks the ORIGINAL sale's own branch, never an unrelated branch", async () => {
    const otherBranch = await createTestBranch(businessId);
    const { sale, product } = await createRefundableSale(2, { stock: 10 });
    await createTestBranchInventory(businessId, otherBranch.id, product.id, { quantity: 50 }); // unrelated branch's own stock

    const res = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: true }]);
    expect(res.status).toBe(201);

    expect(await stockOf(product.id, branchId)).toBe(10); // 8 + 2, the original sale's own branch
    expect(await stockOf(product.id, otherBranch.id)).toBe(50); // completely untouched
  });

  // Test 11 -- required refund decision, no silent default
  it("Test 11: rejects a refund request that omits items entirely", async () => {
    const { sale } = await createRefundableSale(1, { stock: 10 });
    const res = await request(app)
      .post(`/sales/${sale.id}/refund`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: sale.version, reason: "no items sent" });
    expect(res.status).toBe(400);
  });

  it("Test 11b: rejects a line that specifies neither restockable nor restockableQuantity", async () => {
    const { sale } = await createRefundableSale(1, { stock: 10 });
    const res = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 1 }]);
    expect(res.status).toBe(400);
  });

  // Test 12 -- invalid mixed quantities
  it("Test 12: rejects restockableQuantity greater than returnedQuantity", async () => {
    const { sale } = await createRefundableSale(3, { stock: 10 });
    const res = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 3, restockableQuantity: 5 }]);
    expect(res.status).toBe(400);
  });

  describe("Additional structural safety", () => {
    it("rejects a duplicate lineIndex within the same refund request", async () => {
      const product = await stockedProduct(20);
      const otherProduct = await stockedProduct(20);
      const saleRes = await request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ branchId, items: [{ productId: product.id, quantity: 2 }, { productId: otherProduct.id, quantity: 2 }] });
      expect(saleRes.status).toBe(201);
      const sale = await backdateSale(saleRes.body.data.id);

      const res = await refund(sale.id, sale.version, [
        { lineIndex: 0, returnedQuantity: 1, restockable: true },
        { lineIndex: 0, returnedQuantity: 1, restockable: true },
      ]);
      expect(res.status).toBe(400);
    });

    it("rejects an out-of-range lineIndex", async () => {
      const { sale } = await createRefundableSale(1, { stock: 10 });
      const res = await refund(sale.id, sale.version, [{ lineIndex: 5, returnedQuantity: 1, restockable: true }]);
      expect(res.status).toBe(400);
    });

    it("never mutates the original sale's own items/subtotal/total across a partial refund", async () => {
      const { sale } = await createRefundableSale(4, { stock: 10 });
      const before = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });

      await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: true }]);

      const after = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
      expect(after.items).toEqual(before.items);
      expect(Number(after.subtotal)).toBe(Number(before.subtotal));
      expect(Number(after.total)).toBe(Number(before.total));
    });

    it("a partial refund's own scoped reversal total reflects only the refunded portion, not the whole sale", async () => {
      const { sale } = await createRefundableSale(4, { sellingPrice: 100, costPrice: 60, stock: 10 }); // total = 400

      const res = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: true }]);
      expect(res.status).toBe(201);
      expect(Number(res.body.data.total)).toBeCloseTo(-100, 2); // 1/4 of 400, negated
    });

    it("the Sale Receipt transitions issued -> partially_refunded -> refunded across two refund events", async () => {
      const { sale } = await createRefundableSale(2, { stock: 10 });
      const receiptBefore = await prisma.receipts.findFirstOrThrow({ where: { business_id: businessId, sale_id: sale.id, receipt_type: "sale" } });
      expect(receiptBefore.status).toBe("issued");

      const first = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: true }]);
      expect(first.status).toBe(201);
      const receiptAfterFirst = await prisma.receipts.findUniqueOrThrow({ where: { id: receiptBefore.id } });
      expect(receiptAfterFirst.status).toBe("partially_refunded");

      const afterFirst = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
      const second = await refund(sale.id, afterFirst.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: true }]);
      expect(second.status).toBe(201);
      const receiptAfterSecond = await prisma.receipts.findUniqueOrThrow({ where: { id: receiptBefore.id } });
      expect(receiptAfterSecond.status).toBe("refunded");
    });

    it("each refund event generates its own Refund Receipt, scoped to that event's own reversal", async () => {
      const { sale } = await createRefundableSale(2, { stock: 10 });

      const first = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: true }]);
      const afterFirst = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
      const second = await refund(sale.id, afterFirst.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: true }]);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const refundReceipts = await prisma.receipts.findMany({ where: { business_id: businessId, receipt_type: "refund", sale_id: { in: [first.body.data.id, second.body.data.id] } } });
      expect(refundReceipts).toHaveLength(2);
    });
  });

  describe("Concurrency safety", () => {
    it("two concurrent refund requests against the SAME sale can never together over-refund the remaining quantity", async () => {
      const { sale, product } = await createRefundableSale(2, { stock: 10 });

      // Both requests independently try to refund the full remaining
      // quantity (2) using the sale's ORIGINAL version -- the row-level
      // lock must serialize them so only one succeeds; the loser must see
      // a stale version/status and be rejected, never silently both apply.
      const [a, b] = await Promise.all([
        refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: true }]),
        refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: true }]),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      // Total returned quantity across all sale_refund_items for this sale
      // must never exceed the original quantity of 2.
      const saleRefunds = await prisma.sale_refunds.findMany({ where: { sale_id: sale.id }, include: { sale_refund_items: true } });
      const totalReturned = saleRefunds.flatMap((r) => r.sale_refund_items).reduce((sum, i) => sum + Number(i.returned_quantity), 0);
      expect(totalReturned).toBe(2);
      expect(await stockOf(product.id)).toBe(10); // exactly the original 2 restocked, never double-counted
    });

    it("two concurrent PARTIAL refunds that would together exceed the remaining quantity never both succeed", async () => {
      const { sale } = await createRefundableSale(3, { stock: 10 });

      // Remaining = 3. Two concurrent requests each asking for 2 (4 total,
      // more than the 3 available) -- at most one can win with its full
      // request; the real guarantee is that total returned never exceeds 3.
      const [a, b] = await Promise.all([
        refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: false }]),
        refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: false }]),
      ]);

      const succeeded = [a, b].filter((r) => r.status === 201);
      const failed = [a, b].filter((r) => r.status !== 201);
      expect(succeeded.length).toBe(1); // the version guard means exactly one of the two can ever win
      expect(failed.length).toBe(1);
      expect([409, 400]).toContain(failed[0].status);

      const saleRefunds = await prisma.sale_refunds.findMany({ where: { sale_id: sale.id }, include: { sale_refund_items: true } });
      const totalReturned = saleRefunds.flatMap((r) => r.sale_refund_items).reduce((sum, i) => sum + Number(i.returned_quantity), 0);
      expect(totalReturned).toBeLessThanOrEqual(3); // never over-refunded
    });
  });
});
