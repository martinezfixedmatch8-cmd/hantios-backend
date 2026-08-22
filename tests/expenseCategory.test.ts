import request from "supertest";
import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken } from "./helpers/factories";

describe("Expense Categories", () => {
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

  it("returns 401 with no token", async () => {
    const res = await request(app).get("/expense-categories");
    expect(res.status).toBe(401);
  });

  it("lazily seeds exactly the 6 fixed SYSTEM categories on first access, idempotently on repeat access", async () => {
    const res = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const systemNames = res.body.data.filter((c: { type: string }) => c.type === "system").map((c: { name: string }) => c.name).sort();
    // "Inventory Purchases" added in Module 11 Session B -- the auto-created
    // Expense behind a PO payment needs a category, and none of the
    // original 5 fit "money paid to a supplier for goods."
    expect(systemNames).toEqual(["Electricity", "Inventory Purchases", "Misc", "Payroll", "Rent", "Transport"]);

    // Second access must not duplicate them.
    const again = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    const systemNamesAgain = again.body.data.filter((c: { type: string }) => c.type === "system");
    expect(systemNamesAgain).toHaveLength(6);
  });

  it("lets the owner create a CUSTOM category", async () => {
    const res = await request(app)
      .post("/expense-categories")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: `Marketing ${randomUUID()}`, color: "#ff0000" });
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("custom");
    expect(res.body.data.active).toBe(true);
  });

  it("returns 400 for a duplicate category name within the same business", async () => {
    const name = `Duplicate ${randomUUID()}`;
    const first = await request(app).post("/expense-categories").set("Authorization", `Bearer ${ownerToken}`).send({ name });
    expect(first.status).toBe(201);

    const second = await request(app).post("/expense-categories").set("Authorization", `Bearer ${ownerToken}`).send({ name });
    expect(second.status).toBe(400);
  });

  it("lets the owner rename/recolor a CUSTOM category", async () => {
    const created = await request(app)
      .post("/expense-categories")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: `Renamable ${randomUUID()}` });
    const newName = `Renamed ${randomUUID()}`;
    const res = await request(app)
      .patch(`/expense-categories/${created.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: newName, color: "#00ff00" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe(newName);
    expect(res.body.data.color).toBe("#00ff00");
  });

  it("rejects modifying a SYSTEM category", async () => {
    const list = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    const systemCategory = list.body.data.find((c: { type: string }) => c.type === "system");
    const res = await request(app)
      .patch(`/expense-categories/${systemCategory.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Hacked Rent" });
    expect(res.status).toBe(400);
  });

  it("lets the owner deactivate a CUSTOM category, and rejects deactivating it twice", async () => {
    const created = await request(app)
      .post("/expense-categories")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: `Deactivatable ${randomUUID()}` });

    const res = await request(app).post(`/expense-categories/${created.body.data.id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);

    const again = await request(app).post(`/expense-categories/${created.body.data.id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);
    expect(again.status).toBe(400);
  });

  it("rejects deactivating a SYSTEM category", async () => {
    const list = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    const systemCategory = list.body.data.find((c: { type: string; active: boolean }) => c.type === "system" && c.active);
    const res = await request(app).post(`/expense-categories/${systemCategory.id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a category belonging to a different business", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
    const otherCreated = await request(app)
      .post("/expense-categories")
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .send({ name: `Other Business Category ${randomUUID()}` });

    const res = await request(app)
      .patch(`/expense-categories/${otherCreated.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Stolen" });
    expect(res.status).toBe(404);
  });

  it("returns a {data, pagination} envelope", async () => {
    const res = await request(app).get("/expense-categories?pageSize=1").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("pagination");
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });

  // Batch 6 (HNT2-EXP-001) -- restore path.
  describe("restore (HNT2-EXP-001)", () => {
    it("deactivates then restores a CUSTOM category (full round-trip)", async () => {
      const created = await request(app)
        .post("/expense-categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: `Restorable ${randomUUID()}` });
      const id = created.body.data.id;

      const deactivated = await request(app).post(`/expense-categories/${id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);
      expect(deactivated.status).toBe(200);
      expect(deactivated.body.data.active).toBe(false);

      const restored = await request(app).post(`/expense-categories/${id}/restore`).set("Authorization", `Bearer ${ownerToken}`);
      expect(restored.status).toBe(200);
      expect(restored.body.data.active).toBe(true);

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: id, action: "expense_category.restored" } });
      expect(auditRows).toHaveLength(1);
    });

    it("rejects restoring a SYSTEM category", async () => {
      const list = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
      const systemCategory = list.body.data.find((c: { type: string }) => c.type === "system");
      const res = await request(app).post(`/expense-categories/${systemCategory.id}/restore`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(400);
    });

    it("is an idempotent no-op (200, not a 400/409) when restoring an already-active CUSTOM category", async () => {
      const created = await request(app)
        .post("/expense-categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: `AlreadyActive ${randomUUID()}` });
      const id = created.body.data.id;

      const res = await request(app).post(`/expense-categories/${id}/restore`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(true);

      // No new audit row -- this is a pure no-op, not a state transition.
      const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: id, action: "expense_category.restored" } });
      expect(auditRows).toHaveLength(0);
    });

    it("allows creating a new category reusing a name held only by a deactivated category", async () => {
      const name = `ReuseAfterDeactivate ${randomUUID()}`;
      const first = await request(app).post("/expense-categories").set("Authorization", `Bearer ${ownerToken}`).send({ name });
      expect(first.status).toBe(201);
      await request(app).post(`/expense-categories/${first.body.data.id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);

      const second = await request(app).post("/expense-categories").set("Authorization", `Bearer ${ownerToken}`).send({ name });
      expect(second.status).toBe(201);
      expect(second.body.data.id).not.toBe(first.body.data.id);
    });

    it("returns 409 restoring a category whose name a different active category has since claimed", async () => {
      const name = `ClaimedWhileInactive ${randomUUID()}`;
      const original = await request(app).post("/expense-categories").set("Authorization", `Bearer ${ownerToken}`).send({ name });
      await request(app).post(`/expense-categories/${original.body.data.id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);

      const replacement = await request(app).post("/expense-categories").set("Authorization", `Bearer ${ownerToken}`).send({ name });
      expect(replacement.status).toBe(201);

      const restoreRes = await request(app).post(`/expense-categories/${original.body.data.id}/restore`).set("Authorization", `Bearer ${ownerToken}`);
      expect(restoreRes.status).toBe(409);
    });

    it("returns 409 (not a raw 500) when a rename collides with a different active category's name", async () => {
      const nameA = `RenameTargetA ${randomUUID()}`;
      const nameB = `RenameTargetB ${randomUUID()}`;
      await request(app).post("/expense-categories").set("Authorization", `Bearer ${ownerToken}`).send({ name: nameA });
      const b = await request(app).post("/expense-categories").set("Authorization", `Bearer ${ownerToken}`).send({ name: nameB });

      const res = await request(app)
        .patch(`/expense-categories/${b.body.data.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: nameA });
      expect(res.status).toBe(409);
    });

    it("returns 404 restoring a category belonging to a different business", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
      const otherCreated = await request(app)
        .post("/expense-categories")
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .send({ name: `Other Business Restore ${randomUUID()}` });

      const res = await request(app)
        .post(`/expense-categories/${otherCreated.body.data.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it("only owner may restore (manager/accountant denied)", async () => {
      const created = await request(app)
        .post("/expense-categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: `RestoreRbac ${randomUUID()}` });
      await request(app).post(`/expense-categories/${created.body.data.id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);

      for (const role of ["manager", "accountant"] as UserRole[]) {
        const user = await createTestUser(businessId, role);
        const token = mintAccessToken(user);
        const res = await request(app).post(`/expense-categories/${created.body.data.id}/restore`).set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(403);
      }
    });

    it("keeps a historical expense's own category reference readable after the category is deactivated", async () => {
      const created = await request(app)
        .post("/expense-categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: `HistoricalRef ${randomUUID()}` });
      const categoryId = created.body.data.id;

      const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
      const expenseRes = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", `test-${randomUUID()}`)
        .send({ scope: "business", categoryId, amount: 250, expenseDate: isoDate(-1) });
      expect(expenseRes.status).toBe(201);

      await request(app).post(`/expense-categories/${categoryId}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);

      const getRes = await request(app).get(`/expenses/${expenseRes.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.category_id).toBe(categoryId);
      expect(getRes.body.data.category_name).toBe(created.body.data.name);
    });
  });

  describe("full permission matrix", () => {
    const deniedCreate: UserRole[] = ["manager", "accountant", "cashier", "storekeeper", "shareholder", "custom"];
    const deniedRead: UserRole[] = ["cashier", "storekeeper", "shareholder", "custom"];

    it.each(deniedCreate)("denies role=%s creating a category", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).post("/expense-categories").set("Authorization", `Bearer ${token}`).send({ name: `Denied ${randomUUID()}` });
      expect(res.status).toBe(403);
    });

    it.each(deniedRead)("denies role=%s listing categories", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).get("/expense-categories").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("allows manager and accountant to list, but not create", async () => {
      for (const role of ["manager", "accountant"] as UserRole[]) {
        const user = await createTestUser(businessId, role);
        const token = mintAccessToken(user);
        const listRes = await request(app).get("/expense-categories").set("Authorization", `Bearer ${token}`);
        expect(listRes.status).toBe(200);
        const createRes = await request(app).post("/expense-categories").set("Authorization", `Bearer ${token}`).send({ name: `x ${randomUUID()}` });
        expect(createRes.status).toBe(403);
      }
    });

    it("allows super_admin to create and list regardless of role restrictions", async () => {
      const admin = await createTestUser(businessId, "super_admin");
      const token = mintAccessToken(admin);
      const createRes = await request(app).post("/expense-categories").set("Authorization", `Bearer ${token}`).send({ name: `Admin Category ${randomUUID()}` });
      expect(createRes.status).toBe(201);
      const listRes = await request(app).get("/expense-categories").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(200);
    });
  });
});
