import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestProduct, createTestBranch } from "./helpers/factories";
import type { UserRole } from "@prisma/client";

describe("Warehouse Stock Movements", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let productId: string;

  const idemKey = () => `test-${randomUUID()}`;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;

    const product = await createTestProduct(businessId);
    productId = product.id;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  describe("RBAC", () => {
    const cases: { role: UserRole; canWrite: boolean }[] = [
      { role: "owner", canWrite: true },
      { role: "manager", canWrite: true },
      { role: "storekeeper", canWrite: true },
      { role: "accountant", canWrite: false },
      { role: "cashier", canWrite: false },
      { role: "shareholder", canWrite: false },
      { role: "custom", canWrite: false },
      { role: "super_admin", canWrite: true },
    ];

    it.each(cases)("role=$role stock-in write=$canWrite", async ({ role, canWrite }) => {
      const product = await createTestProduct(businessId);
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const res = await request(app)
        .post("/warehouse-movements/stock-in")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ productId: product.id, quantity: 5, unitCost: 10 });
      expect(res.status).toBe(canWrite ? 201 : 403);
    });

    it.each(cases)("role=$role stock-out write=$canWrite", async ({ role, canWrite }) => {
      const product = await createTestProduct(businessId);
      // Seed stock directly so a write-permitted role's stock-out isn't
      // rejected by "insufficient stock" instead of exercising RBAC.
      await request(app)
        .post("/warehouse-movements/stock-in")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ productId: product.id, quantity: 10, unitCost: 10 });

      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const res = await request(app)
        .post("/warehouse-movements/stock-out")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ productId: product.id, quantity: 1, reason: "adjustment" });
      expect(res.status).toBe(canWrite ? 201 : 403);
    });
  });

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/warehouse-movements/stock-in").send({ productId, quantity: 1, unitCost: 1 });
    expect(res.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await request(app)
      .post("/warehouse-movements/stock-in")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ productId, quantity: 1, unitCost: 1 });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a negative/zero quantity", async () => {
    const res = await request(app)
      .post("/warehouse-movements/stock-in")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId, quantity: 0, unitCost: 1 });
    expect(res.status).toBe(400);
  });

  it("returns 400 for stock-out with reason=branch_transfer but no destinationBranchId", async () => {
    const res = await request(app)
      .post("/warehouse-movements/stock-out")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId, quantity: 1, reason: "branch_transfer" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for stock-out with a destinationBranchId but a non-branch_transfer reason", async () => {
    const branch = await createTestBranch(businessId);
    const res = await request(app)
      .post("/warehouse-movements/stock-out")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId, quantity: 1, reason: "damage", destinationBranchId: branch.id });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a cross-business product", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherProduct = await createTestProduct(other.businessId);

    const res = await request(app)
      .post("/warehouse-movements/stock-in")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: otherProduct.id, quantity: 1, unitCost: 1 });
    expect(res.status).toBe(404);
  });

  it("replays the identical response for a repeated Idempotency-Key", async () => {
    const product = await createTestProduct(businessId);
    const key = idemKey();
    const payload = { productId: product.id, quantity: 5, unitCost: 3 };
    const first = await request(app).post("/warehouse-movements/stock-in").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    const second = await request(app).post("/warehouse-movements/stock-in").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it("stock-in on a brand-new product creates an opening-balance warehouse_stock row and a WSM ledger row", async () => {
    const product = await createTestProduct(businessId);

    const res = await request(app)
      .post("/warehouse-movements/stock-in")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: product.id, quantity: 20, unitCost: 4.5, notes: "Initial opening balance" });

    expect(res.status).toBe(201);
    expect(res.body.data.movement_type).toBe("stock_in");
    expect(res.body.data.movement_number).toMatch(/^WSM-\d{6}$/);
    expect(res.body.data.quantity_before).toBe("0");
    expect(res.body.data.quantity_after).toBe("20");

    const stockRow = await prisma.warehouse_stock.findFirst({ where: { business_id: businessId, product_id: product.id } });
    expect(stockRow?.quantity.toString()).toBe("20");
    // "" is the deliberate "no size" sentinel for this table (never NULL --
    // see warehouseStock.ts's own comment on why NULL can't be used here).
    expect(stockRow?.size).toBe("");

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: res.body.data.id, action: "warehouse_movement.stock_in" } });
    expect(auditRows).toHaveLength(1);
  });

  it("stock-in on existing stock increments correctly, then stock-out decrements correctly", async () => {
    const product = await createTestProduct(businessId);

    const in1 = await request(app)
      .post("/warehouse-movements/stock-in")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: product.id, quantity: 10, unitCost: 2 });
    expect(in1.body.data.quantity_after).toBe("10");

    const in2 = await request(app)
      .post("/warehouse-movements/stock-in")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: product.id, quantity: 5, unitCost: 2 });
    expect(in2.body.data.quantity_before).toBe("10");
    expect(in2.body.data.quantity_after).toBe("15");

    const branch = await createTestBranch(businessId);
    const out1 = await request(app)
      .post("/warehouse-movements/stock-out")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: product.id, quantity: 4, reason: "branch_transfer", destinationBranchId: branch.id });
    expect(out1.status).toBe(201);
    expect(out1.body.data.movement_type).toBe("stock_out");
    expect(out1.body.data.quantity_before).toBe("15");
    expect(out1.body.data.quantity_after).toBe("11");
    expect(out1.body.data.destination_branch_id).toBe(branch.id);

    // Stock Out must NEVER touch branch_inventory -- it's the minimal
    // "Stock Out Receipt" until a real Receipts module supersedes it.
    const branchInvRow = await prisma.branch_inventory.findFirst({ where: { branch_id: branch.id, product_id: product.id } });
    expect(branchInvRow).toBeNull();

    const stockRow = await prisma.warehouse_stock.findFirst({ where: { business_id: businessId, product_id: product.id } });
    expect(stockRow?.quantity.toString()).toBe("11");
  });

  it("rejects stock-out against a product with no warehouse stock record (409)", async () => {
    const product = await createTestProduct(businessId);
    const res = await request(app)
      .post("/warehouse-movements/stock-out")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: product.id, quantity: 1, reason: "damage" });
    expect(res.status).toBe(409);
  });

  it("rejects a stock-out that would take warehouse stock negative (409)", async () => {
    const product = await createTestProduct(businessId);
    await request(app)
      .post("/warehouse-movements/stock-in")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: product.id, quantity: 5, unitCost: 1 });

    const res = await request(app)
      .post("/warehouse-movements/stock-out")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: product.id, quantity: 10, reason: "damage" });
    expect(res.status).toBe(409);
  });

  it("rejects stock-in/stock-out against an archived product", async () => {
    const product = await createTestProduct(businessId);
    await prisma.products.update({ where: { id: product.id }, data: { status: "archived" } });

    const res = await request(app)
      .post("/warehouse-movements/stock-in")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: product.id, quantity: 1, unitCost: 1 });
    expect(res.status).toBe(400);
  });

  it("lazily provisions exactly one warehouse per business, reused across movements", async () => {
    const product = await createTestProduct(businessId);
    await request(app)
      .post("/warehouse-movements/stock-in")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ productId: product.id, quantity: 1, unitCost: 1 });

    const warehouses = await prisma.warehouses.findMany({ where: { business_id: businessId } });
    expect(warehouses).toHaveLength(1);
  });

  it("never double-counts under concurrent stock-in on the same brand-new product", async () => {
    const product = await createTestProduct(businessId);

    const [res1, res2] = await Promise.all([
      request(app)
        .post("/warehouse-movements/stock-in")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", `test-concurrent-a-${product.id}`)
        .send({ productId: product.id, quantity: 3, unitCost: 1 }),
      request(app)
        .post("/warehouse-movements/stock-in")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", `test-concurrent-b-${product.id}`)
        .send({ productId: product.id, quantity: 3, unitCost: 1 }),
    ]);
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    const stockRow = await prisma.warehouse_stock.findFirst({ where: { business_id: businessId, product_id: product.id } });
    expect(stockRow?.quantity.toString()).toBe("6");

    // The ledger's own before/after pair must chain consistently regardless
    // of which concurrent request actually landed first (0->3->6 in some
    // order), never both reading quantity_before=0.
    const movements = await prisma.warehouse_movements.findMany({
      where: { business_id: businessId, product_id: product.id },
      orderBy: { quantity_after: "asc" },
    });
    expect(movements).toHaveLength(2);
    expect(movements[0].quantity_before.toString()).toBe("0");
    expect(movements[0].quantity_after.toString()).toBe("3");
    expect(movements[1].quantity_before.toString()).toBe("3");
    expect(movements[1].quantity_after.toString()).toBe("6");
  });
});
