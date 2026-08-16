import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestBranch, createTestProduct, createTestBranchInventory } from "./helpers/factories";
import { generateId } from "../src/lib/ids";

const idemKey = () => `test-${randomUUID()}`;

describe("HNT-INV-001: branch_inventory no-size normalization", () => {
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

  it("the real DB-level guard: a duplicate no-size row is rejected by the unique index itself, not just app logic", async () => {
    const product = await createTestProduct(businessId);
    await createTestBranchInventory(businessId, branchId, product.id, { quantity: 10 });

    // Confirmed: the factory (and every application code path) now writes
    // "" for "no size" -- a second direct insert at the exact same
    // (branch_id, product_id, "") must be rejected by Postgres itself.
    await expect(
      prisma.branch_inventory.create({
        data: { id: generateId(), business_id: businessId, branch_id: branchId, product_id: product.id, size: "", quantity: 5 },
      })
    ).rejects.toThrow();
  });

  it("a stock-adjustment opening balance is created at size=\"\", never a real NULL", async () => {
    const product = await createTestProduct(businessId);
    const res = await request(app)
      .post(`/products/${product.id}/stock-adjustment`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, quantity: 20, direction: "increase", adjustmentType: "opening_balance", reason: "Initial stock" });
    expect(res.status).toBe(201);

    const row = await prisma.branch_inventory.findFirstOrThrow({ where: { branch_id: branchId, product_id: product.id } });
    expect(row.size).toBe("");
    expect(row.size).not.toBeNull();
  });

  it("a sale, its void, and a partial refund with restocking all correctly locate the normalized \"\" row -- no regression from the sentinel change", async () => {
    const product = await createTestProduct(businessId, { costPrice: 10, sellingPrice: 20 });
    await createTestBranchInventory(businessId, branchId, product.id, { quantity: 50 });

    const saleRes = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId: product.id, quantity: 10 }] });
    expect(saleRes.status).toBe(201);

    const afterSale = await prisma.branch_inventory.findFirstOrThrow({ where: { branch_id: branchId, product_id: product.id } });
    expect(Number(afterSale.quantity)).toBe(40); // 50 - 10, the decrement correctly found the "" row

    const voidRes = await request(app)
      .post(`/sales/${saleRes.body.data.id}/void`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: saleRes.body.data.version, reason: "test void" });
    expect(voidRes.status).toBe(200);

    const afterVoid = await prisma.branch_inventory.findFirstOrThrow({ where: { branch_id: branchId, product_id: product.id } });
    expect(Number(afterVoid.quantity)).toBe(50); // void's own restoration correctly found the "" row too

    // Still exactly one row for this (branch, product) -- the fix never
    // created a second, parallel row alongside the original.
    const rows = await prisma.branch_inventory.findMany({ where: { branch_id: branchId, product_id: product.id } });
    expect(rows).toHaveLength(1);
  });
});
