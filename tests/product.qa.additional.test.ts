import request from "supertest";
import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { generateId } from "../src/lib/ids";
import { cleanupTestBusiness } from "./helpers/cleanup";
import {
  signupTestOwner,
  loginTestOwner,
  createTestUser,
  mintAccessToken,
  createTestProduct,
  createTestBranch,
  createTestBranchInventory,
} from "./helpers/factories";

// Independent QA pass on top of the committed tests/product.test.ts suite.
// Targets specific boundary conditions called out for extra scrutiny on this
// module: optimistic locking on all three mutating endpoints, cost-price
// reason-requirement edge cases, transactional rollback under a genuine mid-
// transaction DB failure, cross-business isolation on stock-adjustment
// specifically (mixed product/branch ownership), the full 8-role x 7-endpoint
// RBAC matrix, and the documented size=NULL dedupe limitation (checked for
// data corruption, not just "arbitrary row picked").
describe("Products - QA deep-dive (Session 2)", () => {
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

  const validPayload = () => ({ name: `QA Widget ${randomUUID()}`, costPrice: 10, sellingPrice: 20 });

  // ---------------------------------------------------------------------
  // 1. Optimistic locking on ALL THREE mutating endpoints, plus exact +1
  //    version-increment verification on every successful mutation path.
  // ---------------------------------------------------------------------
  describe("optimistic locking - all mutating endpoints", () => {
    it("rejects a stale version on archive with 409, leaving status/version unaffected", async () => {
      const createRes = await request(app).post("/products").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
      expect(createRes.status).toBe(201);
      const id = createRes.body.data.id;
      const v0 = createRes.body.data.version;
      expect(v0).toBe(0);

      // Bump the version without changing status, so the stale-version archive
      // attempt below hits the version check, not the "already archived" 400.
      const updateRes = await request(app)
        .patch(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ sku: "BUMP-1", version: v0 });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.version).toBe(1);

      // Attempt to archive using the now-stale v0.
      const staleArchive = await request(app)
        .delete(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: v0 });
      expect(staleArchive.status).toBe(409);

      const fetched = await prisma.products.findUnique({ where: { id } });
      expect(fetched?.status).toBe("active");
      expect(fetched?.version).toBe(1); // unaffected by the failed attempt

      // Now archive for real, with the correct version, to prove the
      // legitimate path still works and increments by exactly 1.
      const realArchive = await request(app)
        .delete(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: 1 });
      expect(realArchive.status).toBe(200);
      expect(realArchive.body.data.version).toBe(2);
      expect(realArchive.body.data.status).toBe("archived");
    });

    it("rejects a stale version on restore with 409, leaving status/version unaffected", async () => {
      const createRes = await request(app).post("/products").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
      const id = createRes.body.data.id;

      const archiveRes = await request(app)
        .delete(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: 0 });
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.data.version).toBe(1);
      const staleVersion = 1;

      // Bump version again while staying archived (update doesn't gate on status).
      const updateRes = await request(app)
        .patch(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ sku: "BUMP-2", version: 1 });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.version).toBe(2);
      expect(updateRes.body.data.status).toBe("archived"); // NOTE: update does not restrict archived products

      const staleRestore = await request(app)
        .post(`/products/${id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: staleVersion });
      expect(staleRestore.status).toBe(409);

      const fetched = await prisma.products.findUnique({ where: { id } });
      expect(fetched?.status).toBe("archived");
      expect(fetched?.version).toBe(2); // unaffected by the failed attempt

      const realRestore = await request(app)
        .post(`/products/${id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: 2 });
      expect(realRestore.status).toBe(200);
      expect(realRestore.body.data.version).toBe(3);
      expect(realRestore.body.data.status).toBe("active");
    });

    it("stock-adjustment increments branch_inventory version by exactly 1 per successful adjustment, across several calls", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);

      const first = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branch.id, quantity: 20, direction: "increase", adjustmentType: "opening_balance", reason: "Opening" });
      expect(first.status).toBe(201);
      let stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branch.id, product_id: product.id } });
      const versionAfterCreate = stock?.version;

      const second = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branch.id, quantity: 5, direction: "increase", adjustmentType: "found", reason: "Found extra units" });
      expect(second.status).toBe(201);
      stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branch.id, product_id: product.id } });
      expect(stock?.version).toBe((versionAfterCreate as number) + 1);

      const third = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branch.id, quantity: 3, direction: "decrease", adjustmentType: "damage", reason: "Damaged" });
      expect(third.status).toBe(201);
      stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branch.id, product_id: product.id } });
      expect(stock?.version).toBe((versionAfterCreate as number) + 2);
      expect(Number(stock?.quantity)).toBe(22);
    });
  });

  // ---------------------------------------------------------------------
  // CRITICAL FINDING (discovered during this QA pass, outside the 7
  // requested scrutiny items) -- FIXED. updateProductSchema used to apply
  // Zod's `.partial()` on top of base fields that already carried
  // `.default(...)` (sizes -> [], unitType -> "each", packagingHierarchy ->
  // {}). `.default()` substitutes whenever the resolved value would be
  // undefined -- including "key omitted from the request" -- regardless of
  // `.partial()`, so every PATCH that didn't resend all three fields
  // silently wiped them back to their empty defaults. Fixed by giving
  // updateProductSchema its own non-defaulted definitions for these three
  // fields (src/validation/product.schema.ts) instead of reusing the
  // create-only defaulted versions. This test now passes and stands as the
  // regression coverage for that fix.
  // ---------------------------------------------------------------------
  describe("FIXED: PATCH no longer wipes sizes/unitType/packagingHierarchy on a partial update", () => {
    it("a PATCH that only changes sku must NOT reset sizes/unitType/packagingHierarchy to their empty defaults", async () => {
      const createRes = await request(app)
        .post("/products")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          ...validPayload(),
          sizes: ["S", "M", "L"],
          unitType: "kg",
          packagingHierarchy: { box: 12, carton: 144 },
        });
      expect(createRes.status).toBe(201);
      expect(createRes.body.data.sizes).toEqual(["S", "M", "L"]);
      expect(createRes.body.data.unit_type).toBe("kg");
      expect(createRes.body.data.packaging_hierarchy).toEqual({ box: 12, carton: 144 });
      const id = createRes.body.data.id;
      const version = createRes.body.data.version;

      const patchRes = await request(app)
        .patch(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ sku: "ONLY-SKU-CHANGE", version }); // intentionally does not touch sizes/unitType/packagingHierarchy
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.sku).toBe("ONLY-SKU-CHANGE");

      // These MUST still hold their pre-PATCH values -- a partial update must
      // not touch fields the client never mentioned.
      expect(patchRes.body.data.sizes).toEqual(["S", "M", "L"]);
      expect(patchRes.body.data.unit_type).toBe("kg");
      expect(patchRes.body.data.packaging_hierarchy).toEqual({ box: 12, carton: 144 });
    });
  });

  // ---------------------------------------------------------------------
  // 2. Cost-price-change reason logic - exact boundary conditions.
  // ---------------------------------------------------------------------
  describe("cost-price-change reason boundary conditions", () => {
    it("(a) costPrice sent but numerically equal to current value: no reason required, no PriceHistory row", async () => {
      const createRes = await request(app)
        .post("/products")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ ...validPayload(), costPrice: 10 });
      const id = createRes.body.data.id;
      const version = createRes.body.data.version;

      const res = await request(app)
        .patch(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ costPrice: 10, version }); // same value, no reason
      expect(res.status).toBe(200);

      const history = await prisma.price_history.findMany({ where: { product_id: id } });
      expect(history).toHaveLength(0);
    });

    it("(b) reason sent but costPrice NOT sent: silently ignored, no error, no PriceHistory row", async () => {
      const createRes = await request(app).post("/products").set("Authorization", `Bearer ${ownerToken}`).send(validPayload());
      const id = createRes.body.data.id;
      const version = createRes.body.data.version;

      const res = await request(app)
        .patch(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ sku: "SKU-NO-COST-CHANGE", reason: "This reason should be ignored", version });
      expect(res.status).toBe(200);
      expect(res.body.data.sku).toBe("SKU-NO-COST-CHANGE");

      const history = await prisma.price_history.findMany({ where: { product_id: id } });
      expect(history).toHaveLength(0);

      // The reason should NOT leak into the generic audit-log reason either --
      // confirms it's genuinely ignored, not silently repurposed.
      const auditRows = await prisma.audit_logs.findMany({
        where: { action: "product.updated", entity_id: id },
        orderBy: { created_at: "desc" },
        take: 1,
      });
      expect(auditRows[0]?.reason).not.toBe("This reason should be ignored");
    });

    it("(c) Decimal comparison: string-formatted equal value ('10.00' vs stored 10) is NOT treated as a change", async () => {
      const createRes = await request(app)
        .post("/products")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ ...validPayload(), costPrice: 10 });
      const id = createRes.body.data.id;
      const version = createRes.body.data.version;

      const res = await request(app)
        .patch(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ costPrice: "10.00", version }); // string, zod-coerced to number 10
      expect(res.status).toBe(200);

      const history = await prisma.price_history.findMany({ where: { product_id: id } });
      expect(history).toHaveLength(0);
    });

    it("(c) FIXED post-QA: sub-cent costPrice precision is now rejected at validation (400), regardless of reason -- closes the phantom-PriceHistory-row gap this test originally documented", async () => {
      const createRes = await request(app)
        .post("/products")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ ...validPayload(), costPrice: 10 });
      const id = createRes.body.data.id;
      const version = createRes.body.data.version;

      // 10.001 has more precision than the DB's Decimal(14,2) can represent.
      // Previously this slipped past validation, got treated as "changed" by
      // the pre-rounding Decimal.equals() compare, and wrote a PriceHistory
      // row where old_price === new_price after DB rounding (a phantom
      // audit entry -- the QA finding this test originally captured). Now
      // rejected outright by product.schema.ts's decimalField() refine,
      // before it ever reaches the service -- with or without a reason.
      const withoutReason = await request(app)
        .patch(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ costPrice: 10.001, version });
      expect(withoutReason.status).toBe(400);

      const withReason = await request(app)
        .patch(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ costPrice: 10.001, version, reason: "Sub-cent adjustment" });
      expect(withReason.status).toBe(400);

      const history = await prisma.price_history.findMany({ where: { product_id: id } });
      expect(history).toHaveLength(0); // the phantom row can no longer be created
    });

    it("(c) Decimal comparison: a genuinely different value is detected correctly regardless of trailing zeros", async () => {
      const createRes = await request(app)
        .post("/products")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ ...validPayload(), costPrice: 12.5 });
      const id = createRes.body.data.id;
      const version = createRes.body.data.version;

      const res = await request(app)
        .patch(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ costPrice: "12.50", version }); // equal, string with trailing zero
      expect(res.status).toBe(200);
      let history = await prisma.price_history.findMany({ where: { product_id: id } });
      expect(history).toHaveLength(0);

      const res2 = await request(app)
        .patch(`/products/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ costPrice: "13.50", version: res.body.data.version, reason: "Real change" });
      expect(res2.status).toBe(200);
      history = await prisma.price_history.findMany({ where: { product_id: id } });
      expect(history).toHaveLength(1);
      expect(Number(history[0].old_price)).toBe(12.5);
      expect(Number(history[0].new_price)).toBe(13.5);
    });
  });

  // ---------------------------------------------------------------------
  // 3. Stock-adjustment atomicity. Originally this described forcing a
  //    genuine mid-transaction DB CHECK-constraint failure via a sub-cent
  //    quantity (0.001) that rounds to 0.00 at Decimal(14,2) precision --
  //    that trigger no longer reaches the transaction at all post-fix
  //    (product.schema.ts's decimalField() now rejects it at validation,
  //    400, before the service runs). FIXED post-QA below confirms that.
  //    General transactional-safety (a thrown error inside $transaction
  //    rolls back every statement in it, not just the last one) remains
  //    covered by product.test.ts's concurrent-stock-adjustment race test,
  //    which forces a real conflict() throw mid-transaction via a genuine
  //    race rather than a precision trick.
  // ---------------------------------------------------------------------
  describe("stock-adjustment: sub-cent precision now rejected at validation, not at the DB", () => {
    it("FIXED post-QA: sub-cent quantity (increase path) is rejected 400 before touching branch_inventory", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);

      const res = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branch.id, quantity: 0.001, direction: "increase", adjustmentType: "correction", reason: "Sub-precision correction" });
      expect(res.status).toBe(400);

      const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branch.id, product_id: product.id } });
      expect(stock).toBeNull();

      const adjustments = await prisma.inventory_adjustments.findMany({ where: { product_id: product.id, branch_id: branch.id } });
      expect(adjustments).toHaveLength(0);
    });

    it("FIXED post-QA: sub-cent quantity (decrease path) is rejected 400 before touching existing stock", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);
      await createTestBranchInventory(businessId, branch.id, product.id, { quantity: 20 });

      const res = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branch.id, quantity: 0.004, direction: "decrease", adjustmentType: "correction", reason: "Tiny correction" });
      expect(res.status).toBe(400);

      const stock = await prisma.branch_inventory.findFirst({ where: { branch_id: branch.id, product_id: product.id } });
      expect(Number(stock?.quantity)).toBe(20);
      expect(stock?.version).toBe(0);

      const adjustments = await prisma.inventory_adjustments.findMany({ where: { product_id: product.id, branch_id: branch.id } });
      expect(adjustments).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // 4. Cross-business isolation on stock-adjustment specifically: mixing a
  //    same-business product with a cross-business branch, and vice versa.
  // ---------------------------------------------------------------------
  describe("cross-business isolation on stock-adjustment (mixed ownership)", () => {
    it("404s when the product is same-business but the branchId belongs to a different business, and touches no branch_inventory row anywhere", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);

      const ownProduct = await createTestProduct(businessId);
      const foreignBranch = await createTestBranch(otherOwner.businessId);

      const res = await request(app)
        .post(`/products/${ownProduct.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: foreignBranch.id, quantity: 10, direction: "increase", adjustmentType: "opening_balance", reason: "Should not work" });
      expect(res.status).toBe(404);

      const leakedInOwnBusiness = await prisma.branch_inventory.findFirst({ where: { business_id: businessId, product_id: ownProduct.id } });
      expect(leakedInOwnBusiness).toBeNull();
      const leakedInForeignBusiness = await prisma.branch_inventory.findFirst({ where: { branch_id: foreignBranch.id } });
      expect(leakedInForeignBusiness).toBeNull();
    });

    it("404s when the branch is same-business but the productId belongs to a different business", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);

      const foreignProduct = await createTestProduct(otherOwner.businessId);
      const ownBranch = await createTestBranch(businessId);

      const res = await request(app)
        .post(`/products/${foreignProduct.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: ownBranch.id, quantity: 10, direction: "increase", adjustmentType: "opening_balance", reason: "Should not work" });
      expect(res.status).toBe(404);

      const leaked = await prisma.branch_inventory.findFirst({ where: { branch_id: ownBranch.id } });
      expect(leaked).toBeNull();
    });

    it("404s when BOTH product and branch belong to the same OTHER business (not the caller's) -- sanity check", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const foreignProduct = await createTestProduct(otherOwner.businessId);
      const foreignBranch = await createTestBranch(otherOwner.businessId);

      const res = await request(app)
        .post(`/products/${foreignProduct.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: foreignBranch.id, quantity: 10, direction: "increase", adjustmentType: "opening_balance", reason: "Should not work" });
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------
  // 5. Full RBAC matrix: all 8 roles x all 7 endpoints.
  // ---------------------------------------------------------------------
  describe("RBAC full matrix (8 roles x 7 endpoints)", () => {
    const allRoles: UserRole[] = ["super_admin", "owner", "manager", "accountant", "storekeeper", "cashier", "shareholder", "custom"];
    const tokensByRole: Partial<Record<UserRole, string>> = {};
    const placeholderId = "00000000-0000-0000-0000-000000000000";

    beforeAll(async () => {
      for (const role of allRoles) {
        const user = await createTestUser(businessId, role);
        tokensByRole[role] = mintAccessToken(user);
      }
    });

    const writeAllowed: UserRole[] = ["owner", "manager"]; // super_admin always bypasses separately
    const readAllowed: UserRole[] = ["owner", "manager", "accountant", "storekeeper"];
    const stockAllowed: UserRole[] = ["owner", "manager", "storekeeper"];

    function isAllowed(role: UserRole, allowedList: UserRole[]): boolean {
      return role === "super_admin" || allowedList.includes(role);
    }

    it("POST /products (create) -- only owner/manager/super_admin succeed, everyone else 403", async () => {
      for (const role of allRoles) {
        const token = tokensByRole[role] as string;
        const res = await request(app).post("/products").set("Authorization", `Bearer ${token}`).send(validPayload());
        if (isAllowed(role, writeAllowed)) {
          expect(res.status).toBe(201);
        } else {
          expect(res.status).toBe(403);
        }
      }
    });

    it("GET /products (list) -- owner/manager/accountant/storekeeper/super_admin succeed, cashier/shareholder/custom 403", async () => {
      for (const role of allRoles) {
        const token = tokensByRole[role] as string;
        const res = await request(app).get("/products").set("Authorization", `Bearer ${token}`);
        if (isAllowed(role, readAllowed)) {
          expect(res.status).toBe(200);
        } else {
          expect(res.status).toBe(403);
        }
      }
    });

    it("GET /products/:id -- same matrix as list", async () => {
      const product = await createTestProduct(businessId);
      for (const role of allRoles) {
        const token = tokensByRole[role] as string;
        const res = await request(app).get(`/products/${product.id}`).set("Authorization", `Bearer ${token}`);
        if (isAllowed(role, readAllowed)) {
          expect(res.status).toBe(200);
        } else {
          expect(res.status).toBe(403);
        }
      }
    });

    it("PATCH /products/:id (update) -- only owner/manager/super_admin succeed, everyone else 403 (including on a nonexistent id -- RBAC fires before lookup)", async () => {
      for (const role of allRoles) {
        const token = tokensByRole[role] as string;
        if (isAllowed(role, writeAllowed)) {
          const product = await createTestProduct(businessId);
          const res = await request(app)
            .patch(`/products/${product.id}`)
            .set("Authorization", `Bearer ${token}`)
            .send({ sku: `RBAC-${role}`, version: 0 });
          expect(res.status).toBe(200);
        } else {
          const res = await request(app)
            .patch(`/products/${placeholderId}`)
            .set("Authorization", `Bearer ${token}`)
            .send({ sku: "irrelevant", version: 0 });
          expect(res.status).toBe(403);
        }
      }
    });

    it("DELETE /products/:id (archive) -- only owner/manager/super_admin succeed, everyone else 403", async () => {
      for (const role of allRoles) {
        const token = tokensByRole[role] as string;
        if (isAllowed(role, writeAllowed)) {
          const product = await createTestProduct(businessId);
          const res = await request(app)
            .delete(`/products/${product.id}`)
            .set("Authorization", `Bearer ${token}`)
            .send({ version: 0 });
          expect(res.status).toBe(200);
        } else {
          const res = await request(app)
            .delete(`/products/${placeholderId}`)
            .set("Authorization", `Bearer ${token}`)
            .send({ version: 0 });
          expect(res.status).toBe(403);
        }
      }
    });

    it("POST /products/:id/restore -- only owner/manager/super_admin succeed, everyone else 403", async () => {
      for (const role of allRoles) {
        const token = tokensByRole[role] as string;
        if (isAllowed(role, writeAllowed)) {
          const product = await createTestProduct(businessId);
          await prisma.products.update({ where: { id: product.id }, data: { status: "archived" } });
          const res = await request(app)
            .post(`/products/${product.id}/restore`)
            .set("Authorization", `Bearer ${token}`)
            .send({ version: 0 });
          expect(res.status).toBe(200);
        } else {
          const res = await request(app)
            .post(`/products/${placeholderId}/restore`)
            .set("Authorization", `Bearer ${token}`)
            .send({ version: 0 });
          expect(res.status).toBe(403);
        }
      }
    });

    it("POST /products/:id/stock-adjustment -- owner/manager/storekeeper/super_admin succeed, accountant/cashier/shareholder/custom 403", async () => {
      for (const role of allRoles) {
        const token = tokensByRole[role] as string;
        if (isAllowed(role, stockAllowed)) {
          const product = await createTestProduct(businessId);
          const branch = await createTestBranch(businessId);
          const res = await request(app)
            .post(`/products/${product.id}/stock-adjustment`)
            .set("Authorization", `Bearer ${token}`)
            .send({ branchId: branch.id, quantity: 5, direction: "increase", adjustmentType: "opening_balance", reason: `RBAC ${role}` });
          expect(res.status).toBe(201);
        } else {
          const res = await request(app)
            .post(`/products/${placeholderId}/stock-adjustment`)
            .set("Authorization", `Bearer ${token}`)
            .send({ branchId: placeholderId, quantity: 5, direction: "increase", adjustmentType: "opening_balance", reason: `RBAC ${role}` });
          expect(res.status).toBe(403);
        }
      }
    });

    it("explicitly confirms shareholder and custom are rejected on every one of the 7 endpoints", async () => {
      for (const role of ["shareholder", "custom"] as UserRole[]) {
        const token = tokensByRole[role] as string;
        const results = await Promise.all([
          request(app).post("/products").set("Authorization", `Bearer ${token}`).send(validPayload()),
          request(app).get("/products").set("Authorization", `Bearer ${token}`),
          request(app).get(`/products/${placeholderId}`).set("Authorization", `Bearer ${token}`),
          request(app).patch(`/products/${placeholderId}`).set("Authorization", `Bearer ${token}`).send({ version: 0 }),
          request(app).delete(`/products/${placeholderId}`).set("Authorization", `Bearer ${token}`).send({ version: 0 }),
          request(app).post(`/products/${placeholderId}/restore`).set("Authorization", `Bearer ${token}`).send({ version: 0 }),
          request(app)
            .post(`/products/${placeholderId}/stock-adjustment`)
            .set("Authorization", `Bearer ${token}`)
            .send({ branchId: placeholderId, quantity: 1, direction: "increase", adjustmentType: "opening_balance", reason: "x" }),
        ]);
        for (const res of results) {
          expect(res.status).toBe(403);
        }
      }
    });
  });

  // ---------------------------------------------------------------------
  // 6. size=NULL dedupe limitation: confirm no DATA CORRUPTION when two
  //    branch_inventory rows exist for the same (branch, product, size=null).
  // ---------------------------------------------------------------------
  describe("size=NULL duplicate branch_inventory rows (accepted limitation) -- no data corruption", () => {
    it("adjusts exactly one row, doesn't crash, doesn't silently double-adjust, when two null-size duplicate rows exist", async () => {
      const product = await createTestProduct(businessId);
      const branch = await createTestBranch(businessId);

      // Manually create two rows with identical (branch_id, product_id, size=null)
      // via direct Prisma calls, bypassing the app layer's find-then-branch
      // workaround -- simulates how such duplicates could arise in this repo's
      // documented, accepted gap (NULL doesn't dedupe in the unique index).
      const rowA = await prisma.branch_inventory.create({
        data: { id: generateId(), business_id: businessId, branch_id: branch.id, product_id: product.id, size: null, quantity: 10, version: 0 },
      });
      const rowB = await prisma.branch_inventory.create({
        data: { id: generateId(), business_id: businessId, branch_id: branch.id, product_id: product.id, size: null, quantity: 100, version: 0 },
      });

      const res = await request(app)
        .post(`/products/${product.id}/stock-adjustment`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branch.id, quantity: 4, direction: "increase", adjustmentType: "found", reason: "Duplicate-row sanity check" });
      expect(res.status).toBe(201);

      const rows = await prisma.branch_inventory.findMany({
        where: { branch_id: branch.id, product_id: product.id, size: null },
        orderBy: { id: "asc" },
      });
      expect(rows).toHaveLength(2); // still exactly the two rows, no new row created, none deleted

      const [first, second] = rows;
      const totalQuantity = Number(first.quantity) + Number(second.quantity);
      // Exactly one row absorbed the +4 -- total across both rows moved by
      // exactly the adjustment amount, not 0 (silently lost) and not 8
      // (double-applied to both).
      expect(totalQuantity).toBe(114);

      // Confirm it's genuinely one row unchanged and one row changed by
      // exactly 4, not some other corrupt split.
      const untouchedCount = rows.filter((r) => Number(r.quantity) === 10 || Number(r.quantity) === 100).length;
      const changedCount = rows.filter((r) => Number(r.quantity) === 14 || Number(r.quantity) === 104).length;
      expect(untouchedCount).toBe(1);
      expect(changedCount).toBe(1);

      // Exactly one InventoryAdjustment row was written for this call (no
      // double-write against both rows).
      const adjustments = await prisma.inventory_adjustments.findMany({
        where: { product_id: product.id, branch_id: branch.id, reason: "Duplicate-row sanity check" },
      });
      expect(adjustments).toHaveLength(1);

      // IDs are random UUIDs (generateId() = randomUUID()), not sequential --
      // "order by id asc" is therefore NOT the same as "creation order". The
      // service picks whichever row sorts first lexicographically by id, which
      // is exactly the already-accepted "arbitrary pick among duplicates"
      // limitation (confirmed here empirically: a first run of this same test
      // picked rowA, a later run picked rowB, purely depending on random UUID
      // ordering) -- NOT a bug, just documented precisely rather than assumed.
      const [expectedUpdated, expectedUntouched] = [rowA, rowB].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const updatedRow = await prisma.branch_inventory.findUnique({ where: { id: expectedUpdated.id } });
      const untouchedRow = await prisma.branch_inventory.findUnique({ where: { id: expectedUntouched.id } });
      expect(Number(updatedRow?.quantity)).toBe(Number(expectedUpdated.quantity) + 4);
      expect(Number(untouchedRow?.quantity)).toBe(Number(expectedUntouched.quantity));
      expect(updatedRow?.version).toBe(1);
      expect(untouchedRow?.version).toBe(0);
    });
  });
});
