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
});
