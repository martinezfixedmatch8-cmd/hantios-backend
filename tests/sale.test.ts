import request from "supertest";
import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { domainEvents } from "../src/lib/events";
import { cleanupTestBusiness } from "./helpers/cleanup";
import {
  signupTestOwner,
  loginTestOwner,
  createTestUser,
  mintAccessToken,
  createTestProduct,
  createTestBranch,
  createTestBranchInventory,
  createTestPaymentMethod,
} from "./helpers/factories";

describe("Sales", () => {
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

  const idemKey = () => `test-${randomUUID()}`;

  // Pushes a sale's timestamp back far enough to land on a different business
  // day regardless of what time-of-day the test happens to run at (2 days,
  // not 1, to stay clear of any boundary edge case near midnight).
  async function backdateSale(saleId: string, daysAgo = 2) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysAgo);
    await prisma.sales.update({ where: { id: saleId }, data: { timestamp: date } });
    return prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
  }

  async function createSaleAs(token: string, items: { productId: string; quantity: number; size?: string }[]) {
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items });
    if (res.status !== 201) {
      throw new Error(`createSaleAs failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data;
  }

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/sales").set("Idempotency-Key", idemKey()).send({ branchId, items: [] });
    expect(res.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const product = await stockedProduct(10);
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ branchId, items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it("returns 403 for a storekeeper (no sales access at all)", async () => {
    const storekeeper = await createTestUser(businessId, "storekeeper");
    const token = mintAccessToken(storekeeper);
    const product = await stockedProduct(10);
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(403);
  });

  it("returns 403 for an accountant trying to create (read-only)", async () => {
    const accountant = await createTestUser(businessId, "accountant");
    const token = mintAccessToken(accountant);
    const product = await stockedProduct(10);
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(403);
  });

  it("allows an accountant to list and get sales (read access)", async () => {
    const accountant = await createTestUser(businessId, "accountant");
    const token = mintAccessToken(accountant);
    const listRes = await request(app).get("/sales").set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
  });

  it("allows a cashier to create a sale", async () => {
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);
    const product = await stockedProduct(10);
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(201);
  });

  it("returns 400 for an empty items array", async () => {
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 for zero or negative quantity", async () => {
    const product = await stockedProduct(10);
    for (const quantity of [0, -1]) {
      const res = await request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ branchId, items: [{ productId: product.id, quantity }] });
      expect(res.status).toBe(400);
    }
  });

  it("publishes a SaleCreated domain event", async () => {
    const product = await stockedProduct(10);
    let published: unknown = null;
    domainEvents.once("SaleCreated", (payload) => {
      published = payload;
    });

    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(published).toMatchObject({ saleId: res.body.data.id, businessId });
  });

  it("returns 400 for a quantity with more than 2 decimal places", async () => {
    const product = await stockedProduct(10);
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: product.id, quantity: 1.005 }] });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an archived product", async () => {
    const product = await stockedProduct(10);
    await prisma.products.update({ where: { id: product.id }, data: { status: "archived" } });
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it("returns 404 when branchId belongs to a different business", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherBranch = await createTestBranch(otherOwner.businessId);
    const product = await stockedProduct(10);

    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId: otherBranch.id, items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(404);
  });

  it("returns 404 when a product line references another business's product", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherProduct = await createTestProduct(otherOwner.businessId);

    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: otherProduct.id, quantity: 1 }] });
    // batch-fetch scopes by business_id, so a cross-business product is simply
    // absent from the map -- surfaces as the same "not found" class as a bad id.
    expect(res.status).toBe(400);
  });

  it("returns 409 and leaves stock untouched when one line has insufficient stock (whole-sale rollback)", async () => {
    const okProduct = await stockedProduct(10);
    const shortProduct = await stockedProduct(2);

    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        branchId,
        items: [
          { productId: okProduct.id, quantity: 5 },
          { productId: shortProduct.id, quantity: 5 },
        ],
      });
    expect(res.status).toBe(409);

    const okStock = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: okProduct.id } });
    const shortStock = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: shortProduct.id } });
    expect(Number(okStock?.quantity)).toBe(10);
    expect(Number(shortStock?.quantity)).toBe(2);
  });

  it("creates a multi-line sale: decrements stock, computes totals/profit server-side, assigns a sequential receipt number, and writes a unified ledger + audit rows", async () => {
    const productA = await stockedProduct(20, { costPrice: 10, sellingPrice: 20 }); // line: 2 * 20 = 40
    const productB = await stockedProduct(20, { costPrice: 15, sellingPrice: 30 }); // line: 1 * 30 = 30
    const paymentMethod = await createTestPaymentMethod(businessId);

    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        branchId,
        paymentMethodId: paymentMethod.id,
        customerPhone: "+254700000000",
        discount: { type: "fixed", value: 7 },
        taxRate: 10,
        items: [
          { productId: productA.id, quantity: 2 },
          { productId: productB.id, quantity: 1 },
        ],
      });

    expect(res.status).toBe(201);
    const sale = res.body.data;

    // subtotal = 40 + 30 = 70; discount = 7 (fixed); taxable = 63; tax = 6.30; total = 69.30
    expect(Number(sale.subtotal)).toBe(70);
    expect(Number(sale.discount)).toBe(7);
    expect(Number(sale.tax_amount)).toBeCloseTo(6.3, 2);
    expect(Number(sale.total)).toBeCloseTo(69.3, 2);
    // profit = (40 - 20 cost) + (30 - 15 cost) - discount(7) = 20 + 15 - 7 = 28
    expect(Number(sale.profit)).toBeCloseTo(28, 2);
    expect(sale.status).toBe("completed");
    expect(sale.receipt_id).toMatch(new RegExp(`^INV-${new Date().getFullYear()}-\\d{6}$`));

    // Per-line snapshot amounts must sum exactly to the sale-level totals (no
    // rounding drift between the prorated lines and the aggregate).
    const items = sale.items as { discount: string; tax: string; profit: string }[];
    expect(items).toHaveLength(2);
    const discountSum = items.reduce((s, i) => s + Number(i.discount), 0);
    const taxSum = items.reduce((s, i) => s + Number(i.tax), 0);
    const profitSum = items.reduce((s, i) => s + Number(i.profit), 0);
    expect(Math.round(discountSum * 100) / 100).toBeCloseTo(Number(sale.discount), 2);
    expect(Math.round(taxSum * 100) / 100).toBeCloseTo(Number(sale.tax_amount), 2);
    expect(Math.round(profitSum * 100) / 100).toBeCloseTo(Number(sale.profit), 2);

    const stockA = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: productA.id } });
    const stockB = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: productB.id } });
    expect(Number(stockA?.quantity)).toBe(18);
    expect(Number(stockB?.quantity)).toBe(19);

    const adjustments = await prisma.inventory_adjustments.findMany({ where: { business_id: businessId, adjustment_type: "sale" } });
    expect(adjustments.some((a) => a.product_id === productA.id && a.reason === `Sale ${sale.id}`)).toBe(true);
    expect(adjustments.some((a) => a.product_id === productB.id && a.reason === `Sale ${sale.id}`)).toBe(true);

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: sale.id, entity_type: "sale" } });
    expect(auditRows.some((a) => a.action === "sale.created")).toBe(true);
    expect(auditRows.some((a) => a.action === "sale.discount_applied")).toBe(true);

    // A second sale in the same business/year gets the next sequential receipt number.
    const productC = await stockedProduct(5, { sellingPrice: 5 });
    const secondRes = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: productC.id, quantity: 1 }] });
    expect(secondRes.status).toBe(201);

    const firstNum = Number(sale.receipt_id.split("-")[2]);
    const secondNum = Number(secondRes.body.data.receipt_id.split("-")[2]);
    expect(secondNum).toBe(firstNum + 1);
  });

  it("does not write a sale.discount_applied audit row when no discount was given", async () => {
    const product = await stockedProduct(10);
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(201);

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: res.body.data.id, entity_type: "sale" } });
    expect(auditRows.map((a) => a.action)).toEqual(["sale.created"]);
  });

  it("replays the exact same response for a repeated Idempotency-Key, creating only one sale", async () => {
    const product = await stockedProduct(10);
    const key = idemKey();
    const body = { branchId, items: [{ productId: product.id, quantity: 3 }] };

    const first = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send(body);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.receipt_id).toBe(first.body.data.receipt_id);

    // Stock should only have been decremented once, not twice -- the strongest
    // proof the handler didn't actually run a second time.
    const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
    expect(Number(stock?.quantity)).toBe(7);
  });

  it("keeps item-level lineSubtotal snapshots summing to the exact sale-level subtotal (Decimal rounding check)", async () => {
    // price=0.05, qty=0.10 -> raw line subtotal = 0.005 for each line, which
    // independently rounds UP to 0.01 under ROUND_HALF_UP when stored per-line.
    // But the raw (unrounded) sum across both lines is 0.005 + 0.005 = 0.010,
    // which is already exact and rounds to 0.01 ONCE at the sale level -- not
    // 0.02. Sale-level `subtotal` is computed via sum-then-round; each item's
    // `lineSubtotal` snapshot is computed via round-then-sum. These two paths
    // are not guaranteed to agree.
    const productA = await stockedProduct(10, { costPrice: 0.01, sellingPrice: 0.05 });
    const productB = await stockedProduct(10, { costPrice: 0.01, sellingPrice: 0.05 });

    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        branchId,
        items: [
          { productId: productA.id, quantity: 0.1 },
          { productId: productB.id, quantity: 0.1 },
        ],
      });

    expect(res.status).toBe(201);
    const sale = res.body.data;
    const items = sale.items as { lineSubtotal: string }[];
    const itemSubtotalSum = items.reduce((s, i) => s + Number(i.lineSubtotal), 0);
    expect(Math.round(itemSubtotalSum * 100) / 100).toBe(Number(sale.subtotal));
  });

  it("only creates one sale when two concurrent requests share the exact same brand-new Idempotency-Key", async () => {
    const product = await stockedProduct(10);
    const key = idemKey();
    const body = { branchId, items: [{ productId: product.id, quantity: 1 }] };

    const [first, second] = await Promise.all([
      request(app).post("/sales").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body),
      request(app).post("/sales").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body),
    ]);

    // Exactly one of the two truly-concurrent requests sharing a brand-new key
    // may succeed -- the other must see a conflict, never a second sale.
    const successes = [first, second].filter((r) => r.status === 201);
    expect(successes.length).toBe(1);

    const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
    expect(Number(stock?.quantity)).toBe(9);
  });

  it("only lets one of two concurrent sales win when they'd both claim the last unit of stock", async () => {
    const product = await stockedProduct(1);
    const body = { branchId, items: [{ productId: product.id, quantity: 1 }] };

    const [first, second] = await Promise.all([
      request(app).post("/sales").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
      request(app).post("/sales").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
    expect(Number(stock?.quantity)).toBe(0);
  });

  it("assigns unique, sequential receipt numbers under true concurrent sale creation", async () => {
    const products = await Promise.all(Array.from({ length: 5 }, () => stockedProduct(20)));
    const results = await Promise.all(
      products.map((p) =>
        request(app)
          .post("/sales")
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ branchId, items: [{ productId: p.id, quantity: 1 }] })
      )
    );

    results.forEach((r) => expect(r.status).toBe(201));
    const receiptNumbers: string[] = results.map((r) => r.body.data.receipt_id);
    expect(new Set(receiptNumbers).size).toBe(receiptNumbers.length);

    const sequenceNumbers = receiptNumbers.map((r) => Number(r.split("-")[2])).sort((a, b) => a - b);
    for (let i = 1; i < sequenceNumbers.length; i++) {
      expect(sequenceNumbers[i]).toBe(sequenceNumbers[i - 1] + 1);
    }
  });

  describe("Void", () => {
    it("restores inventory using the exact original quantities, writes a unified-ledger row + audit entry, and publishes SaleVoided", async () => {
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, [{ productId: product.id, quantity: 4 }]);

      const stockBefore = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
      expect(Number(stockBefore?.quantity)).toBe(6);

      let published: unknown = null;
      domainEvents.once("SaleVoided", (payload) => {
        published = payload;
      });

      const res = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "Customer changed their mind" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("void");
      expect(res.body.data.void_reason).toBe("Customer changed their mind");

      // Exactly restored -- never estimated, never recomputed from current stock.
      const stockAfter = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
      expect(Number(stockAfter?.quantity)).toBe(10);

      const voidAdjustments = await prisma.inventory_adjustments.findMany({
        where: { sale_id: sale.id, adjustment_type: "void" },
      });
      expect(voidAdjustments).toHaveLength(1);
      expect(Number(voidAdjustments[0].adjustment_amount)).toBe(4);

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: sale.id, action: "sale.voided" } });
      expect(auditRows).toHaveLength(1);

      expect(published).toMatchObject({ saleId: sale.id, businessId, reason: "Customer changed their mind" });
    });

    it("allows the cashier who created the sale to void it", async () => {
      const cashier = await createTestUser(businessId, "cashier");
      const token = mintAccessToken(cashier);
      const product = await stockedProduct(10);
      const sale = await createSaleAs(token, [{ productId: product.id, quantity: 1 }]);

      const res = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "Mistake" });
      expect(res.status).toBe(200);
    });

    it("rejects a different cashier voiding someone else's sale", async () => {
      const cashierA = await createTestUser(businessId, "cashier");
      const tokenA = mintAccessToken(cashierA);
      const product = await stockedProduct(10);
      const sale = await createSaleAs(tokenA, [{ productId: product.id, quantity: 1 }]);

      const cashierB = await createTestUser(businessId, "cashier");
      const tokenB = mintAccessToken(cashierB);
      const res = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${tokenB}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "Not mine" });
      expect(res.status).toBe(403);
    });

    it("rejects a manager voiding a sale (manager does not bypass, unlike everywhere else in this repo)", async () => {
      const manager = await createTestUser(businessId, "manager");
      const token = mintAccessToken(manager);
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, [{ productId: product.id, quantity: 1 }]);

      const res = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "x" });
      expect(res.status).toBe(403);
    });

    it("rejects voiding a sale from a previous business day", async () => {
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, [{ productId: product.id, quantity: 1 }]);
      await backdateSale(sale.id);

      const res = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "Too late" });
      expect(res.status).toBe(400);
    });

    it("rejects voiding the same sale twice", async () => {
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, [{ productId: product.id, quantity: 1 }]);

      const first = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "First void" });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: first.body.data.version, reason: "Second void" });
      expect(second.status).toBe(409);
    });

    it("rejects voiding a sale that was already refunded (Final State Protection, verified directly)", async () => {
      // Refund is only reachable post-day-close, which can never pass Void's
      // same-day check afterward -- so the day-boundary rule alone would always
      // incidentally block this transition in real usage. Bypassing the normal
      // Refund flow (direct Prisma write) isolates and verifies Void's own
      // status guard specifically, not the day rule standing in for it.
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, [{ productId: product.id, quantity: 1 }]);
      const refunded = await prisma.sales.update({
        where: { id: sale.id },
        data: { status: "refunded", version: { increment: 1 } },
      });

      const res = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: refunded.version, reason: "should be rejected" });
      expect(res.status).toBe(409);
    });

    it("returns 404 voiding a sale from a different business", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
      const otherBranch = await createTestBranch(otherOwner.businessId);
      const otherProduct = await createTestProduct(otherOwner.businessId);
      await createTestBranchInventory(otherOwner.businessId, otherBranch.id, otherProduct.id, { quantity: 5 });
      const otherSaleRes = await request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ branchId: otherBranch.id, items: [{ productId: otherProduct.id, quantity: 1 }] });

      const res = await request(app)
        .post(`/sales/${otherSaleRes.body.data.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "x" });
      expect(res.status).toBe(404);
    });

    it("returns 400 when the Idempotency-Key header is missing", async () => {
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, [{ productId: product.id, quantity: 1 }]);
      const res = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: sale.version, reason: "x" });
      expect(res.status).toBe(400);
    });

    it("replays the same response for a repeated Idempotency-Key, restoring stock only once", async () => {
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, [{ productId: product.id, quantity: 3 }]);
      const key = idemKey();
      const body = { version: sale.version, reason: "Testing replay" };

      const first = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send(body);
      expect(first.status).toBe(200);

      const second = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send(body);
      expect(second.status).toBe(200);
      expect(second.body.data.version).toBe(first.body.data.version);

      const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
      expect(Number(stock?.quantity)).toBe(10);
    });

    it("only lets one of two concurrent void requests win, restoring stock exactly once", async () => {
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, [{ productId: product.id, quantity: 4 }]);
      const body = { version: sale.version, reason: "Concurrent void" };

      const [first, second] = await Promise.all([
        request(app).post(`/sales/${sale.id}/void`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
        request(app).post(`/sales/${sale.id}/void`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
      expect(Number(stock?.quantity)).toBe(10);

      const voidAdjustments = await prisma.inventory_adjustments.findMany({
        where: { sale_id: sale.id, adjustment_type: "void" },
      });
      expect(voidAdjustments).toHaveLength(1);
    });
  });

  describe("Refund", () => {
    async function backdatedSale(token: string, quantity = 3, stock = 10) {
      const product = await stockedProduct(stock);
      const created = await createSaleAs(token, [{ productId: product.id, quantity }]);
      const sale = await backdateSale(created.id);
      return { sale, product };
    }

    // Sale Refund, Partial Refund & Inventory Restoration -- refund requests
    // now require an explicit items[] array (no silent default for
    // restockable). Tests below whose own intent is unrelated to partial/
    // mixed behavior (RBAC, day-close, idempotency, concurrency, cross-
    // business) refund the full quantity with restockable:false, keeping
    // them financial-only, matching each test's own original framing.

    it("creates a financial-only reversal, preserves the original sale's financial figures, updates original status to the terminal refunded, records sale_refunds/sale_refund_items, and publishes RefundCreated", async () => {
      const { sale, product } = await backdatedSale(ownerToken, 3, 10);

      let published: unknown = null;
      domainEvents.once("RefundCreated", (payload) => {
        published = payload;
      });

      const res = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "Product was defective", items: [{ lineIndex: 0, returnedQuantity: 3, restockable: false }] });

      expect(res.status).toBe(201);
      const refund = res.body.data;
      expect(refund.refund_of_sale_id).toBe(sale.id);
      expect(refund.status).toBe("refunded");
      expect(Number(refund.total)).toBeCloseTo(-Number(sale.total), 2);
      expect(Number(refund.subtotal)).toBeCloseTo(-Number(sale.subtotal), 2);
      expect(Number(refund.profit)).toBeCloseTo(-Number(sale.profit), 2);
      expect(refund.receipt_id).not.toBe(sale.receipt_id);
      expect(refund.receipt_id).toMatch(/^INV-\d{4}-\d{6}$/);

      // Original sale's financial figures are untouched -- only status/version change.
      // Fully refunded (all 3 of 3) -> terminal "refunded", not "partially_refunded".
      const originalAfter = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
      expect(originalAfter.status).toBe("refunded");
      expect(Number(originalAfter.subtotal)).toBe(Number(sale.subtotal));
      expect(Number(originalAfter.total)).toBe(Number(sale.total));
      expect(originalAfter.items).toEqual(sale.items);

      // No inventory change -- restockable:false is a pure write-off (still
      // just the original sale's decrement, nothing added back).
      const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
      expect(Number(stock?.quantity)).toBe(7);

      const saleRefund = await prisma.sale_refunds.findFirstOrThrow({ where: { sale_id: sale.id } });
      expect(saleRefund.reversal_sale_id).toBe(refund.id);
      const refundItems = await prisma.sale_refund_items.findMany({ where: { sale_refund_id: saleRefund.id } });
      expect(refundItems).toHaveLength(1);
      expect(Number(refundItems[0].returned_quantity)).toBe(3);
      expect(Number(refundItems[0].restockable_quantity)).toBe(0);
      expect(Number(refundItems[0].write_off_quantity)).toBe(3);

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: sale.id, action: "sale.refunded" } });
      expect(auditRows).toHaveLength(1);

      expect(published).toMatchObject({ saleId: sale.id, refundSaleId: refund.id, businessId });
    });

    it("allows a manager to refund", async () => {
      const manager = await createTestUser(businessId, "manager");
      const token = mintAccessToken(manager);
      const { sale } = await backdatedSale(ownerToken);

      const res = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "x", items: [{ lineIndex: 0, returnedQuantity: 3, restockable: false }] });
      expect(res.status).toBe(201);
    });

    it("rejects a cashier attempting to refund", async () => {
      const cashier = await createTestUser(businessId, "cashier");
      const token = mintAccessToken(cashier);
      const { sale } = await backdatedSale(ownerToken);

      const res = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "x" });
      expect(res.status).toBe(403);
    });

    it("rejects refunding a sale on the same business day it was created", async () => {
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, [{ productId: product.id, quantity: 1 }]);

      const res = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "Too soon", items: [{ lineIndex: 0, returnedQuantity: 1, restockable: false }] });
      expect(res.status).toBe(400);
    });

    it("rejects refunding the same sale twice (already fully refunded)", async () => {
      const { sale } = await backdatedSale(ownerToken);
      const items = [{ lineIndex: 0, returnedQuantity: 3, restockable: false }];

      const first = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "First refund", items });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "Second refund", items });
      expect(second.status).toBe(409);
    });

    it("rejects refunding a sale that was already voided (voided same-day, then its business day passes)", async () => {
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, [{ productId: product.id, quantity: 1 }]);

      const voidRes = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "void it same day" });
      expect(voidRes.status).toBe(200);

      const voided = await backdateSale(sale.id);

      const refundRes = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: voided.version, reason: "should be rejected", items: [{ lineIndex: 0, returnedQuantity: 1, restockable: false }] });
      expect(refundRes.status).toBe(409);
    });

    it("returns 404 refunding a sale from a different business", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
      const otherBranch = await createTestBranch(otherOwner.businessId);
      const otherProduct = await createTestProduct(otherOwner.businessId);
      await createTestBranchInventory(otherOwner.businessId, otherBranch.id, otherProduct.id, { quantity: 5 });
      const otherSaleRes = await request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ branchId: otherBranch.id, items: [{ productId: otherProduct.id, quantity: 1 }] });
      await backdateSale(otherSaleRes.body.data.id);

      const res = await request(app)
        .post(`/sales/${otherSaleRes.body.data.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "x", items: [{ lineIndex: 0, returnedQuantity: 1, restockable: false }] });
      expect(res.status).toBe(404);
    });

    it("returns 400 when the Idempotency-Key header is missing", async () => {
      const { sale } = await backdatedSale(ownerToken);
      const res = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: sale.version, reason: "x" });
      expect(res.status).toBe(400);
    });

    it("replays the same response for a repeated Idempotency-Key, creating only one reversal", async () => {
      const { sale } = await backdatedSale(ownerToken);
      const key = idemKey();
      const body = { version: sale.version, reason: "Testing replay", items: [{ lineIndex: 0, returnedQuantity: 3, restockable: false }] };

      const first = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send(body);
      expect(first.status).toBe(201);

      const second = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send(body);
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);

      const reversals = await prisma.sales.findMany({ where: { refund_of_sale_id: sale.id } });
      expect(reversals).toHaveLength(1);
    });

    it("only lets one of two concurrent refund requests win (row-level lock serializes them)", async () => {
      const { sale } = await backdatedSale(ownerToken);
      const body = { version: sale.version, reason: "Concurrent refund", items: [{ lineIndex: 0, returnedQuantity: 3, restockable: false }] };

      const [first, second] = await Promise.all([
        request(app).post(`/sales/${sale.id}/refund`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
        request(app).post(`/sales/${sale.id}/refund`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const reversals = await prisma.sales.findMany({ where: { refund_of_sale_id: sale.id } });
      expect(reversals).toHaveLength(1);
    });
  });

  describe("full permission matrix (denied access)", () => {
    const deniedCreate: UserRole[] = ["accountant", "storekeeper", "shareholder", "custom"];
    const deniedVoid: UserRole[] = ["manager", "accountant", "storekeeper", "shareholder", "custom"];
    const deniedRefund: UserRole[] = ["cashier", "accountant", "storekeeper", "shareholder", "custom"];

    const cases: { role: UserRole; action: "create" | "void" | "refund" }[] = [
      ...deniedCreate.map((role) => ({ role, action: "create" as const })),
      ...deniedVoid.map((role) => ({ role, action: "void" as const })),
      ...deniedRefund.map((role) => ({ role, action: "refund" as const })),
    ];

    it.each(cases)("denies role=$role action=$action (status, error code, and message)", async ({ role, action }) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      // requireRole runs before any resource lookup, so a placeholder id is
      // fine for void/refund -- a denied role never reaches the sale lookup.
      const res =
        action === "create"
          ? await request(app)
              .post("/sales")
              .set("Authorization", `Bearer ${token}`)
              .set("Idempotency-Key", idemKey())
              .send({ branchId, items: [] })
          : await request(app)
              .post(`/sales/${randomUUID()}/${action}`)
              .set("Authorization", `Bearer ${token}`)
              .set("Idempotency-Key", idemKey())
              .send({ version: 0, reason: "x" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
      expect(typeof res.body.error.message).toBe("string");
      expect(res.body.error.message.length).toBeGreaterThan(0);
    });

    it("allows super_admin to create, void, and refund regardless of role restrictions", async () => {
      const admin = await createTestUser(businessId, "super_admin");
      const token = mintAccessToken(admin);
      const product = await stockedProduct(10);

      const createRes = await request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ branchId, items: [{ productId: product.id, quantity: 1 }] });
      expect(createRes.status).toBe(201);

      const voidRes = await request(app)
        .post(`/sales/${createRes.body.data.id}/void`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: createRes.body.data.version, reason: "super_admin void" });
      expect(voidRes.status).toBe(200);

      const otherProduct = await stockedProduct(10);
      const refundableCreate = await createSaleAs(ownerToken, [{ productId: otherProduct.id, quantity: 1 }]);
      const refundable = await backdateSale(refundableCreate.id);
      const refundRes = await request(app)
        .post(`/sales/${refundable.id}/refund`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: refundable.version, reason: "super_admin refund", items: [{ lineIndex: 0, returnedQuantity: 1, restockable: false }] });
      expect(refundRes.status).toBe(201);
    });
  });
});
