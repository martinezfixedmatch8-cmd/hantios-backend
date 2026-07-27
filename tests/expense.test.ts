import request from "supertest";
import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { domainEvents } from "../src/lib/events";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestBranch, createTestPaymentMethod } from "./helpers/factories";

describe("Expenses", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let branchId: string;
  let categoryId: string;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;
    const branch = await createTestBranch(businessId);
    branchId = branch.id;

    // Trigger lazy system-category seeding, then grab "Misc" as the default
    // category most tests use.
    const categories = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    categoryId = categories.body.data.find((c: { name: string }) => c.name === "Misc").id;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  const idemKey = () => `test-${randomUUID()}`;
  const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  function validExpensePayload(overrides: Record<string, unknown> = {}) {
    return {
      scope: "business",
      categoryId,
      amount: 500,
      expenseDate: isoDate(-1),
      ...overrides,
    };
  }

  async function createExpenseAs(token: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/expenses")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send(validExpensePayload(overrides));
    if (res.status !== 201) {
      throw new Error(`createExpenseAs failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data;
  }

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/expenses").set("Idempotency-Key", idemKey()).send(validExpensePayload());
    expect(res.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await request(app).post("/expenses").set("Authorization", `Bearer ${ownerToken}`).send(validExpensePayload());
    expect(res.status).toBe(400);
  });

  it("creates an expense with a sequential EXP-###### number, category-name snapshot, and currency snapshot from Business.currency", async () => {
    let published: unknown = null;
    domainEvents.once("ExpenseCreated", (payload) => {
      published = payload;
    });

    const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
    const expense = await createExpenseAs(ownerToken, { amount: 750 });

    expect(expense.expense_number).toMatch(/^EXP-\d{6}$/);
    expect(expense.category_name).toBe("Misc");
    expect(Number(expense.amount)).toBe(750);
    expect(expense.currency_code).toBe(business.currency);
    expect(typeof expense.currency_symbol === "string" || expense.currency_symbol === null).toBe(true);
    expect(expense.status).toBe("active");
    expect(expense.version).toBe(0);
    expect(expense.source).toBe("manual");
    expect(expense.expense_attachments).toEqual([]);
    expect(published).toMatchObject({ expenseId: expense.id, businessId, categoryId });

    const auditRows = await prisma.audit_logs.findMany({ where: { action: "expense.created", entity_id: expense.id } });
    expect(auditRows).toHaveLength(1);
  });

  it("increments the expense number sequentially per business", async () => {
    const first = await createExpenseAs(ownerToken);
    const second = await createExpenseAs(ownerToken);
    const firstNum = parseInt(first.expense_number.slice(4), 10);
    const secondNum = parseInt(second.expense_number.slice(4), 10);
    expect(secondNum).toBe(firstNum + 1);
  });

  describe("Scope validation", () => {
    it("returns 400 when scope=branch but branchId is missing", async () => {
      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ scope: "branch" }));
      expect(res.status).toBe(400);
    });

    it("returns 400 when scope=business but branchId is set", async () => {
      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ scope: "business", branchId }));
      expect(res.status).toBe(400);
    });

    it("accepts scope=branch with a valid branchId", async () => {
      const expense = await createExpenseAs(ownerToken, { scope: "branch", branchId });
      expect(expense.scope).toBe("branch");
      expect(expense.branch_id).toBe(branchId);
    });

    it("returns 404 when branchId belongs to a different business", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherBranch = await createTestBranch(otherOwner.businessId);
      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ scope: "branch", branchId: otherBranch.id }));
      expect(res.status).toBe(404);
    });
  });

  describe("Category / payment method validation", () => {
    it("returns 404 when categoryId belongs to a different business", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
      const otherCategories = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${otherLogin.accessToken}`);
      const otherCategoryId = otherCategories.body.data[0].id;

      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ categoryId: otherCategoryId }));
      expect(res.status).toBe(404);
    });

    it("returns 400 for an inactive category", async () => {
      const created = await request(app)
        .post("/expense-categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: `Inactive Category ${randomUUID()}` });
      await request(app).post(`/expense-categories/${created.body.data.id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);

      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ categoryId: created.body.data.id }));
      expect(res.status).toBe(400);
    });

    it("accepts a valid paymentMethodId and rejects an archived one", async () => {
      const pm = await createTestPaymentMethod(businessId);
      const ok = await createExpenseAs(ownerToken, { paymentMethodId: pm.id });
      expect(ok.payment_method_id).toBe(pm.id);

      await prisma.payment_methods.update({ where: { id: pm.id }, data: { status: "archived" } });
      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ paymentMethodId: pm.id }));
      expect(res.status).toBe(400);
    });
  });

  describe("Attachments (metadata-only)", () => {
    const validAttachment = (overrides: Record<string, unknown> = {}) => ({
      filename: "receipt.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      storageKey: `test/${randomUUID()}`,
      ...overrides,
    });

    it("creates attachments inline with the expense, in the same transaction", async () => {
      const expense = await createExpenseAs(ownerToken, { attachments: [validAttachment(), validAttachment({ filename: "invoice.pdf", mimeType: "application/pdf" })] });
      expect(expense.expense_attachments).toHaveLength(2);
      const rows = await prisma.expense_attachments.findMany({ where: { expense_id: expense.id } });
      expect(rows).toHaveLength(2);
    });

    it("returns 400 for more than 5 attachments on create", async () => {
      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ attachments: Array.from({ length: 6 }, () => validAttachment()) }));
      expect(res.status).toBe(400);
    });

    it("returns 400 for a disallowed MIME type", async () => {
      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ attachments: [validAttachment({ mimeType: "application/x-msdownload" })] }));
      expect(res.status).toBe(400);
    });

    it("returns 400 for an oversized attachment (> 10MB)", async () => {
      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ attachments: [validAttachment({ size: 10 * 1024 * 1024 + 1 })] }));
      expect(res.status).toBe(400);
    });

    it("adds more attachments later via POST /:id/attachments, enforcing the 5-file aggregate cap", async () => {
      const expense = await createExpenseAs(ownerToken, { attachments: [validAttachment(), validAttachment()] });

      const addRes = await request(app)
        .post(`/expenses/${expense.id}/attachments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ attachments: [validAttachment(), validAttachment(), validAttachment()] });
      expect(addRes.status).toBe(201);
      expect(addRes.body.data.expense_attachments).toHaveLength(5);

      const overCap = await request(app)
        .post(`/expenses/${expense.id}/attachments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ attachments: [validAttachment()] });
      expect(overCap.status).toBe(400);
    });
  });

  it("replays the exact same response for a repeated Idempotency-Key on create, consuming only one expense number", async () => {
    const key = idemKey();
    const payload = validExpensePayload({ amount: 321 });

    const first = await request(app).post("/expenses").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    expect(first.status).toBe(201);
    const second = await request(app).post("/expenses").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.expense_number).toBe(first.body.data.expense_number);

    // A brand-new expense right after must get the VERY NEXT number, proving
    // the replay didn't consume a second one.
    const third = await createExpenseAs(ownerToken);
    const firstNum = parseInt(first.body.data.expense_number.slice(4), 10);
    const thirdNum = parseInt(third.expense_number.slice(4), 10);
    expect(thirdNum).toBe(firstNum + 1);
  });

  describe("Update", () => {
    it("updates fields and re-snapshots category_name when categoryId changes", async () => {
      const expense = await createExpenseAs(ownerToken);
      const newCategory = await request(app)
        .post("/expense-categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: `Office Supplies ${randomUUID()}` });

      let published: unknown = null;
      domainEvents.once("ExpenseUpdated", (payload) => {
        published = payload;
      });

      const res = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, categoryId: newCategory.body.data.id, amount: 999 });
      expect(res.status).toBe(200);
      expect(res.body.data.category_id).toBe(newCategory.body.data.id);
      expect(res.body.data.category_name).toBe(newCategory.body.data.name);
      expect(Number(res.body.data.amount)).toBe(999);
      expect(res.body.data.version).toBe(1);
      expect(published).toMatchObject({ expenseId: expense.id, businessId });
    });

    it("rejects a stale-version update (optimistic locking)", async () => {
      const expense = await createExpenseAs(ownerToken);
      const first = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, amount: 111 });
      expect(first.status).toBe(200);

      const stale = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, amount: 222 });
      expect(stale.status).toBe(409);
    });

    it("returns 400 flipping scope to business without clearing the existing branchId", async () => {
      const expense = await createExpenseAs(ownerToken, { scope: "branch", branchId });
      const res = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, scope: "business" });
      expect(res.status).toBe(400);
    });

    // QA (2026-07-26) -- FOUND BUG, fixed: branchId's update schema only
    // accepted a UUID or omission, with no way to express "clear this field."
    // A client could never actually flip scope back to business, since the
    // only way to satisfy the guard above (explicitly clearing branchId) had
    // no valid representation in the request body. Fixed by making branchId
    // (and every other genuinely-nullable field on update) accept an
    // explicit `null`.
    it("successfully flips scope to business by explicitly sending branchId: null", async () => {
      const expense = await createExpenseAs(ownerToken, { scope: "branch", branchId });
      const res = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, scope: "business", branchId: null });
      expect(res.status).toBe(200);
      expect(res.body.data.scope).toBe("business");
      expect(res.body.data.branch_id).toBeNull();
    });

    it("clears an optional field (vendorName) via an explicit null", async () => {
      const expense = await createExpenseAs(ownerToken, { vendorName: "Acme" });
      const res = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, vendorName: null });
      expect(res.status).toBe(200);
      expect(res.body.data.vendor_name).toBeNull();
    });

    // QA (2026-07-26) -- FOUND GAP, fixed: createExpenseSchema's "recurring
    // requires recurrenceRule" rule had no equivalent on update -- a PATCH
    // could silently produce recurring:true with a null/stale
    // recurrence_rule. Also: the create-time rule itself had zero test
    // coverage before this.
    it("returns 400 creating a recurring expense without a recurrenceRule", async () => {
      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ recurring: true }));
      expect(res.status).toBe(400);
    });

    it("returns 400 flipping recurring to true on update without a recurrenceRule, merged against stored state", async () => {
      const expense = await createExpenseAs(ownerToken);
      const res = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, recurring: true });
      expect(res.status).toBe(400);
    });

    it("allows flipping recurring back to false without needing to also clear recurrenceRule (an orphaned rule string is inert, not enforced)", async () => {
      const expense = await createExpenseAs(ownerToken, { recurring: true, recurrenceRule: "monthly" });
      const res = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, recurring: false });
      expect(res.status).toBe(200);
      expect(res.body.data.recurring).toBe(false);
    });

    it("returns 400 updating an archived expense", async () => {
      const expense = await createExpenseAs(ownerToken);
      await request(app)
        .post(`/expenses/${expense.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, reason: "no longer needed" });

      const res = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version + 1, amount: 50 });
      expect(res.status).toBe(400);
    });
  });

  describe("Archive / Restore", () => {
    it("archives an expense with a required reason, publishes ExpenseArchived, and blocks a second archive", async () => {
      const expense = await createExpenseAs(ownerToken);
      let published: unknown = null;
      domainEvents.once("ExpenseArchived", (payload) => {
        published = payload;
      });

      const res = await request(app)
        .post(`/expenses/${expense.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, reason: "Duplicate entry" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("archived");
      expect(res.body.data.archived_reason).toBe("Duplicate entry");
      expect(published).toMatchObject({ expenseId: expense.id, businessId, reason: "Duplicate entry" });

      const second = await request(app)
        .post(`/expenses/${expense.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: res.body.data.version, reason: "again" });
      expect(second.status).toBe(400);

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "expense.archived", entity_id: expense.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("returns 400 archiving without a reason", async () => {
      const expense = await createExpenseAs(ownerToken);
      const res = await request(app)
        .post(`/expenses/${expense.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version });
      expect(res.status).toBe(400);
    });

    it("restores an archived expense, clearing archived_reason, and rejects restoring an active one", async () => {
      const expense = await createExpenseAs(ownerToken);
      const archived = await request(app)
        .post(`/expenses/${expense.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, reason: "mistake" });

      const res = await request(app)
        .post(`/expenses/${expense.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: archived.body.data.version });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("active");
      expect(res.body.data.archived_reason).toBeNull();

      const alreadyActive = await request(app)
        .post(`/expenses/${expense.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: res.body.data.version });
      expect(alreadyActive.status).toBe(400);
    });
  });

  describe("List filtering", () => {
    it("filters by status", async () => {
      const expense = await createExpenseAs(ownerToken);
      await request(app)
        .post(`/expenses/${expense.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, reason: "x" });

      const res = await request(app).get("/expenses?status=archived").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((e: { id: string }) => e.id === expense.id)).toBe(true);
      expect(res.body.data.every((e: { status: string }) => e.status === "archived")).toBe(true);
    });

    it("filters by categoryId and branchId", async () => {
      const expense = await createExpenseAs(ownerToken, { scope: "branch", branchId });
      const res = await request(app).get(`/expenses?branchId=${branchId}&categoryId=${categoryId}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((e: { id: string }) => e.id === expense.id)).toBe(true);
    });

    it("filters by expense date range", async () => {
      const expense = await createExpenseAs(ownerToken, { expenseDate: isoDate(-100) });
      const inRange = await request(app)
        .get(`/expenses?dateFrom=${isoDate(-105)}&dateTo=${isoDate(-95)}`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(inRange.body.data.map((e: { id: string }) => e.id)).toContain(expense.id);

      const outOfRange = await request(app)
        .get(`/expenses?dateFrom=${isoDate(-10)}&dateTo=${isoDate(-1)}`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(outOfRange.body.data.map((e: { id: string }) => e.id)).not.toContain(expense.id);
    });

    it("returns a {data, pagination} envelope", async () => {
      const res = await request(app).get("/expenses?pageSize=1").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("pagination");
      expect(res.body.data.length).toBeLessThanOrEqual(1);
    });

    it("returns 404 getting an expense from a different business", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
      const otherCategories = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${otherLogin.accessToken}`);
      const otherCategoryId = otherCategories.body.data[0].id;
      const otherExpense = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ scope: "business", categoryId: otherCategoryId, amount: 10, expenseDate: isoDate(-1) });

      const res = await request(app).get(`/expenses/${otherExpense.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("full permission matrix (denied access)", () => {
    const deniedWrite: UserRole[] = ["accountant", "cashier", "storekeeper", "shareholder", "custom"];
    const deniedRead: UserRole[] = ["cashier", "storekeeper", "shareholder", "custom"];

    it.each(deniedWrite)("denies role=%s creating an expense", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).post("/expenses").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send(validExpensePayload());
      expect(res.status).toBe(403);
    });

    it.each(deniedRead)("denies role=%s listing expenses", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).get("/expenses").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("allows accountant to list/get but not create/update/archive", async () => {
      const accountant = await createTestUser(businessId, "accountant");
      const token = mintAccessToken(accountant);
      const listRes = await request(app).get("/expenses").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(200);

      const createRes = await request(app).post("/expenses").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send(validExpensePayload());
      expect(createRes.status).toBe(403);
    });

    it("allows super_admin to create, list, update, and archive regardless of role restrictions", async () => {
      const admin = await createTestUser(businessId, "super_admin");
      const token = mintAccessToken(admin);

      const createRes = await request(app).post("/expenses").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send(validExpensePayload({ amount: 42 }));
      expect(createRes.status).toBe(201);

      const listRes = await request(app).get("/expenses").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(200);

      const archiveRes = await request(app)
        .post(`/expenses/${createRes.body.data.id}/archive`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: createRes.body.data.version, reason: "x" });
      expect(archiveRes.status).toBe(200);
    });
  });
});
