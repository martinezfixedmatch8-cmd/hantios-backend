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
  createTestCategory,
  createTestBranch,
  createTestBranchInventory,
} from "./helpers/factories";

describe("Products", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  const validPayload = () => ({ name: `Widget ${randomUUID()}`, costPrice: 10, sellingPrice: 20 });

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/products").send(validPayload());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a cashier (POS-only, no product management)", async () => {
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);
    const res = await request(app).post("/products").set("Authorization", `Bearer ${token}`).send(validPayload());
    expect(res.status).toBe(403);
  });

  it("returns 403 for a storekeeper trying to create (read + stock-adjustment only, not CRUD)", async () => {
    const storekeeper = await createTestUser(businessId, "storekeeper");
    const token = mintAccessToken(storekeeper);
    const res = await request(app).post("/products").set("Authorization", `Bearer ${token}`).send(validPayload());
    expect(res.status).toBe(403);
  });

  it("allows a storekeeper to list and get products (read access)", async () => {
    const product = await createTestProduct(businessId);
    const storekeeper = await createTestUser(businessId, "storekeeper");
    const token = mintAccessToken(storekeeper);

    const listRes = await request(app).get("/products").set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);

    const getRes = await request(app).get(`/products/${product.id}`).set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
  });

  it("allows super_admin to bypass the owner/manager restriction", async () => {
    const admin = await createTestUser(businessId, "super_admin");
    const token = mintAccessToken(admin);
    const res = await request(app).post("/products").set("Authorization", `Bearer ${token}`).send(validPayload());
    expect(res.status).toBe(201);
  });

  it("returns 400 for a missing name/costPrice", async () => {
    const res = await request(app).post("/products").set("Authorization", `Bearer ${ownerToken}`).send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when categoryId references a category in a different business", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherCategory = await createTestCategory(otherOwner.businessId);

    const res = await request(app)
      .post("/products")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...validPayload(), categoryId: otherCategory.id });
    expect(res.status).toBe(404);
  });

  it("creates a product with a valid same-business category", async () => {
    const category = await createTestCategory(businessId);
    const res = await request(app)
      .post("/products")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...validPayload(), categoryId: category.id });
    expect(res.status).toBe(201);
    expect(res.body.data.category_id).toBe(category.id);
    expect(res.body.data.version).toBe(0);
  });

  it("full lifecycle: create -> update (no price change) -> archive -> restore", async () => {
    const createRes = await request(app).post("/products").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
    expect(createRes.status).toBe(201);
    const id = createRes.body.data.id;
    let version = createRes.body.data.version;

    const updateRes = await request(app)
      .patch(`/products/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ sku: "SKU-1", version });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.sku).toBe("SKU-1");
    version = updateRes.body.data.version;
    expect(version).toBe(1);

    const archiveRes = await request(app)
      .delete(`/products/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ version });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.status).toBe("archived");
    version = archiveRes.body.data.version;

    const restoreRes = await request(app)
      .post(`/products/${id}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ version });
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.status).toBe("active");
  });

  it("rejects a cost-price change with no reason", async () => {
    const createRes = await request(app).post("/products").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
    const id = createRes.body.data.id;
    const version = createRes.body.data.version;

    const res = await request(app)
      .patch(`/products/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ costPrice: 15, version });
    expect(res.status).toBe(400);
  });

  it("accepts a cost-price change with a reason, and writes a PriceHistory row", async () => {
    const createRes = await request(app).post("/products").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
    const id = createRes.body.data.id;
    const version = createRes.body.data.version;

    const res = await request(app)
      .patch(`/products/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ costPrice: 15, version, reason: "Supplier price increase" });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.cost_price)).toBe(15);

    const history = await prisma.price_history.findMany({ where: { product_id: id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ reason: "Supplier price increase" });
    expect(Number(history[0].old_price)).toBe(10);
    expect(Number(history[0].new_price)).toBe(15);
  });

  it("does not write a PriceHistory row when sellingPrice changes without costPrice changing", async () => {
    const createRes = await request(app).post("/products").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
    const id = createRes.body.data.id;
    const version = createRes.body.data.version;

    const res = await request(app)
      .patch(`/products/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ sellingPrice: 25, version });
    expect(res.status).toBe(200);

    const history = await prisma.price_history.findMany({ where: { product_id: id } });
    expect(history).toHaveLength(0);
  });

  it("rejects an update with a stale version (optimistic lock)", async () => {
    const createRes = await request(app).post("/products").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
    const id = createRes.body.data.id;
    const staleVersion = createRes.body.data.version;

    const first = await request(app)
      .patch(`/products/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ sku: "SKU-A", version: staleVersion });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/products/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ sku: "SKU-B", version: staleVersion });
    expect(second.status).toBe(409);
  });

  it("isolates products across businesses (404, not a data leak)", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherProduct = await createTestProduct(otherOwner.businessId);

    const res = await request(app).get(`/products/${otherProduct.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  describe("stock-adjustment", () => {
    it("returns 403 for accountant (read-only, no stock-adjustment)", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);
      const accountant = await createTestUser(businessId, "accountant");
      const token = mintAccessToken(accountant);

      const res = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${token}`)
        .send({ branchId: branch.id, quantity: 10, direction: "increase", adjustmentType: "opening_balance", reason: "Initial stock" });
      expect(res.status).toBe(403);
    });

    it("allows a storekeeper to perform a stock adjustment", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);
      const storekeeper = await createTestUser(businessId, "storekeeper");
      const token = mintAccessToken(storekeeper);

      const res = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${token}`)
        .send({ branchId: branch.id, quantity: 10, direction: "increase", adjustmentType: "opening_balance", reason: "Initial stock" });
      expect(res.status).toBe(201);
    });

    it("creates a branch_inventory row from nothing on an increase (opening balance)", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);

      const res = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branch.id, quantity: 50, direction: "increase", adjustmentType: "opening_balance", reason: "Initial stock" });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ adjustment_type: "opening_balance", packaging_level: "each" });
      expect(Number(res.body.data.quantity_before)).toBe(0);
      expect(Number(res.body.data.quantity_after)).toBe(50);

      const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branch.id, product_id: product.id } });
      expect(Number(stock?.quantity)).toBe(50);
    });

    it("rejects a decrease when no stock record exists yet", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);

      const res = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branch.id, quantity: 5, direction: "decrease", adjustmentType: "damage", reason: "Broken in transit" });
      expect(res.status).toBe(409);
    });

    it("rejects a decrease that would take stock negative", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);
      await createTestBranchInventory(businessId, branch.id, product.id, { quantity: 5 });

      const res = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branch.id, quantity: 10, direction: "decrease", adjustmentType: "loss", reason: "Stock count shortfall" });
      expect(res.status).toBe(409);

      const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branch.id, product_id: product.id } });
      expect(Number(stock?.quantity)).toBe(5);
    });

    it("increases and decreases correctly on existing stock, and writes InventoryAdjustment rows", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);
      await createTestBranchInventory(businessId, branch.id, product.id, { quantity: 20 });

      const decreaseRes = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branch.id, quantity: 8, direction: "decrease", adjustmentType: "damage", reason: "Damaged units" });
      expect(decreaseRes.status).toBe(201);

      const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branch.id, product_id: product.id } });
      expect(Number(stock?.quantity)).toBe(12);
      expect(stock?.version).toBe(1);

      const adjustments = await prisma.inventory_adjustments.findMany({ where: { product_id: product.id, branch_id: branch.id } });
      expect(adjustments).toHaveLength(1);
      expect(adjustments[0]).toMatchObject({ adjustment_type: "damage", adjustment_amount: expect.anything() });

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "product.stock_adjusted", entity_id: adjustments[0].id } });
      expect(auditRows).toHaveLength(1);
    });

    it("only lets one of two concurrent stock adjustments win when it would take stock negative", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);
      await createTestBranchInventory(businessId, branch.id, product.id, { quantity: 10 });

      const body = { branchId: branch.id, quantity: 10, direction: "decrease", adjustmentType: "loss", reason: "Concurrent count" };
      const [first, second] = await Promise.all([
        request(app).post(`/products/${product.id}/stock-adjustment`).set("Authorization", `Bearer ${ownerToken}`).send(body),
        request(app).post(`/products/${product.id}/stock-adjustment`).set("Authorization", `Bearer ${ownerToken}`).send(body),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branch.id, product_id: product.id } });
      expect(Number(stock?.quantity)).toBe(0);
    });
  });
});
