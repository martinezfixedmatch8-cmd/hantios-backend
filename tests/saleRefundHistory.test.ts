import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import {
  signupTestOwner,
  loginTestOwner,
  createTestProduct,
  createTestBranch,
  createTestBranchInventory,
} from "./helpers/factories";

const idemKey = () => `test-${randomUUID()}`;

// Batch 5 (HNT2-SALE-001) -- the refund-history read surface: GET
// /sales/:id/refunds (the confirmed dedicated-paginated-endpoint shape,
// Phase 0 Decision 1) plus GET /sales/:id's own additive effectiveTotal
// field. Reuses saleRefundRestocking.test.ts's own established helper
// shapes (createRefundableSale/refund/backdateSale) rather than
// reinventing them.
describe("Sale Refund History (HNT2-SALE-001)", () => {
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

  async function backdateSale(saleId: string, daysAgo = 2) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysAgo);
    await prisma.sales.update({ where: { id: saleId }, data: { timestamp: date } });
    return prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
  }

  async function createRefundableSale(quantity: number, overrides: Partial<{ costPrice: number; sellingPrice: number; stock: number }> = {}) {
    const stock = overrides.stock ?? quantity + 10;
    const product = await createTestProduct(businessId, { costPrice: overrides.costPrice, sellingPrice: overrides.sellingPrice });
    await createTestBranchInventory(businessId, branchId, product.id, { quantity: stock });
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: product.id, quantity }] });
    expect(res.status).toBe(201);
    const sale = await backdateSale(res.body.data.id);
    return { sale, product };
  }

  async function refund(saleId: string, version: number, items: Record<string, unknown>[], reason = "test refund") {
    const res = await request(app)
      .post(`/sales/${saleId}/refund`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version, reason, items });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function getRefunds(saleId: string, token = ownerToken, query = "") {
    return request(app).get(`/sales/${saleId}/refunds${query}`).set("Authorization", `Bearer ${token}`);
  }

  async function getSale(saleId: string, token = ownerToken) {
    return request(app).get(`/sales/${saleId}`).set("Authorization", `Bearer ${token}`);
  }

  it("a sale with no refunds returns an empty history, not an error", async () => {
    const { sale } = await createRefundableSale(2, { stock: 10 });
    const res = await getRefunds(sale.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it("GET /sales/:id exposes effectiveTotal equal to the original total when there are no refunds", async () => {
    const { sale } = await createRefundableSale(2, { stock: 10 });
    const res = await getSale(sale.id);
    expect(res.status).toBe(200);
    expect(res.body.data.effectiveTotal).toBe(res.body.data.total);
    // Bounded/additive: the refund history array itself must never be
    // embedded here (Phase 0 Decision 1, confirmed).
    expect(res.body.data.sale_refunds).toBeUndefined();
    expect(res.body.data.refunds).toBeUndefined();
  });

  it("a sale with one full refund: header + line fields, refundTotal positive, signedReversalTotal negative, effectiveTotal reflects it", async () => {
    const { sale, product } = await createRefundableSale(2, { stock: 10, sellingPrice: 100, costPrice: 40 });
    await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: true }], "customer returned item");

    const listRes = await getRefunds(sale.id);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);

    const event = listRes.body.data[0];
    expect(event.reason).toBe("customer returned item");
    expect(event.actor.userId).toBeTruthy();
    expect(typeof event.actor.userName).toBe("string");
    expect(Number(event.refundTotal)).toBeGreaterThan(0);
    expect(Number(event.signedReversalTotal)).toBeLessThan(0);
    // The pair must be exact negations of each other -- a response-shape
    // clarity fix only, never a change to the underlying signed value.
    expect(Number(event.refundTotal)).toBeCloseTo(-Number(event.signedReversalTotal), 5);
    expect(event.lines).toHaveLength(1);
    expect(event.lines[0]).toMatchObject({ lineIndex: 0, productId: product.id, returnedQuantity: "2", restockableQuantity: "2", writeOffQuantity: "0" });
    expect(event.lines[0].productName).toBeTruthy();

    const saleRes = await getSale(sale.id);
    expect(Number(saleRes.body.data.effectiveTotal)).toBeCloseTo(Number(sale.total) - Number(event.refundTotal), 5);
  });

  it("mixed restockability within one refund event is reflected correctly (some lines restocked, some written off)", async () => {
    const product1 = await createTestProduct(businessId, { sellingPrice: 50, costPrice: 20 });
    const product2 = await createTestProduct(businessId, { sellingPrice: 30, costPrice: 10 });
    await createTestBranchInventory(businessId, branchId, product1.id, { quantity: 20 });
    await createTestBranchInventory(businessId, branchId, product2.id, { quantity: 20 });
    const createRes = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        branchId,
        items: [
          { productId: product1.id, quantity: 3 },
          { productId: product2.id, quantity: 4 },
        ],
      });
    expect(createRes.status).toBe(201);
    const sale = await backdateSale(createRes.body.data.id);

    await refund(sale.id, sale.version, [
      { lineIndex: 0, returnedQuantity: 3, restockable: true },
      { lineIndex: 1, returnedQuantity: 4, restockable: false },
    ]);

    const listRes = await getRefunds(sale.id);
    const lines = listRes.body.data[0].lines as Array<Record<string, unknown>>;
    const line0 = lines.find((l) => l.lineIndex === 0)!;
    const line1 = lines.find((l) => l.lineIndex === 1)!;
    expect(line0).toMatchObject({ restockableQuantity: "3", writeOffQuantity: "0" });
    expect(line1).toMatchObject({ restockableQuantity: "0", writeOffQuantity: "4" });
  });

  it("multiple partial refunds across separate events: deterministic chronological ordering and per-event correctness", async () => {
    const { sale, product } = await createRefundableSale(6, { stock: 10 });
    await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: true }], "first partial");
    // refund()'s own return value is the REVERSAL sale row -- its .version
    // is unrelated to the original sale's own version count. The correct
    // version for the next refund call comes from re-fetching the original
    // sale itself, matching saleRefundRestocking.test.ts's own established
    // "Test 8" precedent exactly.
    const afterFirst = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    await refund(sale.id, afterFirst.version, [{ lineIndex: 0, returnedQuantity: 3, restockable: false }], "second partial");

    const listRes = await getRefunds(sale.id);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(2);
    // Default order (created_at, matching pagination.ts's own default
    // "desc") -- most recent first.
    expect(listRes.body.data[0].reason).toBe("second partial");
    expect(listRes.body.data[1].reason).toBe("first partial");

    const timestamps = listRes.body.data.map((e: { timestamp: string }) => new Date(e.timestamp).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);

    const saleRes = await getSale(sale.id);
    // Two refunds of 2 and 3 units out of a 6-unit sale -- effectiveTotal
    // must reflect BOTH events summed, not just the latest.
    const totalRefunded = listRes.body.data.reduce((sum: number, e: { refundTotal: string }) => sum + Number(e.refundTotal), 0);
    expect(Number(saleRes.body.data.effectiveTotal)).toBeCloseTo(Number(sale.total) - totalRefunded, 5);
    void product;
  });

  it("a refund event carries a receiptReference when a Refund Receipt exists for it", async () => {
    const { sale } = await createRefundableSale(2, { stock: 10 });
    await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: true }]);

    const listRes = await getRefunds(sale.id);
    const event = listRes.body.data[0];
    expect(event.receiptReference).not.toBeNull();
    expect(event.receiptReference.id).toBeTruthy();
    expect(event.receiptReference.receiptNumber).toBeTruthy();
  });

  it("pagination: page/pageSize are honored on the dedicated endpoint", async () => {
    const { sale } = await createRefundableSale(6, { stock: 10 });
    // Same fix as above -- re-fetch the ORIGINAL sale's own version between
    // visits, never the reversal response's own (unrelated) version.
    for (const qty of [1, 1, 1]) {
      const current = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
      await refund(sale.id, current.version, [{ lineIndex: 0, returnedQuantity: qty, restockable: true }]);
    }

    const page1 = await getRefunds(sale.id, ownerToken, "?page=1&pageSize=2");
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.pagination).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });

    const page2 = await getRefunds(sale.id, ownerToken, "?page=2&pageSize=2");
    expect(page2.body.data).toHaveLength(1);
  });

  // Review round 2 -- a lower-severity version of the same class of issue
  // Debt History had: resolveListQuery's own orderBy is single-key
  // (created_at alone), so two refund events sharing an identical
  // created_at could otherwise return in a non-repeatable order across
  // offset-paginated pages. Constructed deliberately -- two real refund
  // events, then their sale_refunds.created_at rows force-aligned to an
  // identical timestamp -- to prove the `id` secondary sort key genuinely
  // keeps page 1/page 2 stable and non-overlapping, not just in the common
  // case where timestamps happen to differ.
  it("pagination is stable across multiple refund events sharing the exact same created_at timestamp", async () => {
    const { sale } = await createRefundableSale(4, { stock: 10 });
    const first = await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: true }]);
    const afterFirst = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    const second = await refund(sale.id, afterFirst.version, [{ lineIndex: 0, returnedQuantity: 1, restockable: true }]);

    const firstRefundRow = await prisma.sale_refunds.findFirstOrThrow({ where: { reversal_sale_id: first.id } });
    const secondRefundRow = await prisma.sale_refunds.findFirstOrThrow({ where: { reversal_sale_id: second.id } });

    const tiedTimestamp = new Date("2026-01-15T12:00:00.000Z");
    await prisma.sale_refunds.update({ where: { id: firstRefundRow.id }, data: { created_at: tiedTimestamp } });
    await prisma.sale_refunds.update({ where: { id: secondRefundRow.id }, data: { created_at: tiedTimestamp } });

    // Confirm the tie is real, not assumed.
    const [reread1, reread2] = await Promise.all([
      prisma.sale_refunds.findUniqueOrThrow({ where: { id: firstRefundRow.id } }),
      prisma.sale_refunds.findUniqueOrThrow({ where: { id: secondRefundRow.id } }),
    ]);
    expect(reread1.created_at.getTime()).toBe(tiedTimestamp.getTime());
    expect(reread2.created_at.getTime()).toBe(tiedTimestamp.getTime());

    const page1 = await getRefunds(sale.id, ownerToken, "?page=1&pageSize=1");
    const page2 = await getRefunds(sale.id, ownerToken, "?page=2&pageSize=1");
    expect(page1.body.data).toHaveLength(1);
    expect(page2.body.data).toHaveLength(1);
    const idsSeen = [page1.body.data[0].id, page2.body.data[0].id];
    expect(new Set(idsSeen).size).toBe(2); // no duplicate, no skip
    expect(new Set(idsSeen)).toEqual(new Set([firstRefundRow.id, secondRefundRow.id]));

    // Repeat the exact same walk again -- the order must be REPEATABLE,
    // not just non-overlapping by chance on a single run.
    const page1Again = await getRefunds(sale.id, ownerToken, "?page=1&pageSize=1");
    const page2Again = await getRefunds(sale.id, ownerToken, "?page=2&pageSize=1");
    expect(page1Again.body.data[0].id).toBe(page1.body.data[0].id);
    expect(page2Again.body.data[0].id).toBe(page2.body.data[0].id);
  });

  it("cross-tenant isolation: a different business gets the same clean 404 as elsewhere in this repo, both for the sale and the refund history", async () => {
    const { sale } = await createRefundableSale(2, { stock: 10 });
    await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: true }]);

    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const saleRes = await getSale(sale.id, otherLogin.accessToken);
    expect(saleRes.status).toBe(404);

    const refundsRes = await getRefunds(sale.id, otherLogin.accessToken);
    expect(refundsRes.status).toBe(404);
  });

  it("original sale immutability is untouched by the refund-history read (a pure read addition)", async () => {
    const { sale } = await createRefundableSale(2, { stock: 10 });
    const before = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    await refund(sale.id, sale.version, [{ lineIndex: 0, returnedQuantity: 2, restockable: true }]);
    await getRefunds(sale.id);
    await getSale(sale.id);
    const after = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
    // total/subtotal/items on the ORIGINAL row must never be rewritten by
    // reading its own refund history (status legitimately changes via the
    // refund itself, which already happened before either read call).
    expect(after.total.toString()).toBe(before.total.toString());
    expect(after.subtotal.toString()).toBe(before.subtotal.toString());
    expect(JSON.stringify(after.items)).toBe(JSON.stringify(before.items));
  });
});
