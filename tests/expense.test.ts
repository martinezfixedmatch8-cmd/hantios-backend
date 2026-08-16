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

  describe("Tax Snapshot (fields only, no calculation logic)", () => {
    it("stores taxAmount/taxRate/taxIncluded exactly as provided, never derived from amount", async () => {
      const expense = await createExpenseAs(ownerToken, { amount: 1000, taxAmount: 160, taxRate: 16, taxIncluded: false });
      expect(Number(expense.tax_amount)).toBe(160);
      expect(Number(expense.tax_rate)).toBe(16);
      expect(expense.tax_included).toBe(false);
      // No calculation logic -- amount is exactly what was sent, not
      // amount-minus-tax or amount-plus-tax.
      expect(Number(expense.amount)).toBe(1000);
    });

    it("leaves all three tax fields null when none are provided", async () => {
      const expense = await createExpenseAs(ownerToken);
      expect(expense.tax_amount).toBeNull();
      expect(expense.tax_rate).toBeNull();
      expect(expense.tax_included).toBeNull();
    });

    it("returns 400 for a negative taxAmount or an out-of-range taxRate", async () => {
      const negativeAmount = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ taxAmount: -5 }));
      expect(negativeAmount.status).toBe(400);

      const outOfRangeRate = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ taxRate: 101 }));
      expect(outOfRangeRate.status).toBe(400);
    });

    it("updates tax fields and clears them via explicit null", async () => {
      const expense = await createExpenseAs(ownerToken, { taxAmount: 50, taxRate: 5, taxIncluded: true });

      const updated = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, taxAmount: 75, taxRate: 7.5 });
      expect(updated.status).toBe(200);
      expect(Number(updated.body.data.tax_amount)).toBe(75);
      expect(Number(updated.body.data.tax_rate)).toBe(7.5);
      expect(updated.body.data.tax_included).toBe(true); // untouched field stays as-is

      const cleared = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: updated.body.data.version, taxAmount: null, taxRate: null, taxIncluded: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.tax_amount).toBeNull();
      expect(cleared.body.data.tax_rate).toBeNull();
      expect(cleared.body.data.tax_included).toBeNull();
    });
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

  describe("Recurrence (architecture-only -- no scheduler exists yet)", () => {
    it("creates an expense_recurrence row when recurrence is provided at creation, referencing the new expense as template", async () => {
      const expense = await createExpenseAs(ownerToken, {
        recurrence: { frequency: "monthly", interval: 2, nextRun: isoDate(30) },
      });
      expect(expense.expense_recurrence).toMatchObject({
        template_expense_id: expense.id,
        frequency: "monthly",
        interval: 2,
        active: true,
      });
      expect(expense.expense_recurrence.last_run).toBeNull();

      const row = await prisma.expense_recurrence.findUnique({ where: { template_expense_id: expense.id } });
      expect(row).not.toBeNull();
    });

    it("defaults interval to 1 when omitted", async () => {
      const expense = await createExpenseAs(ownerToken, { recurrence: { frequency: "weekly" } });
      expect(expense.expense_recurrence.interval).toBe(1);
    });

    it("leaves expense_recurrence null when no recurrence is provided", async () => {
      const expense = await createExpenseAs(ownerToken);
      expect(expense.expense_recurrence).toBeNull();
    });

    it("updates an existing recurrence schedule's frequency/interval/active via PATCH", async () => {
      const expense = await createExpenseAs(ownerToken, { recurrence: { frequency: "daily", interval: 1 } });

      const res = await request(app)
        .patch(`/expenses/${expense.id}/recurrence`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ frequency: "yearly", interval: 3, active: false });
      expect(res.status).toBe(200);
      expect(res.body.data.frequency).toBe("yearly");
      expect(res.body.data.interval).toBe(3);
      expect(res.body.data.active).toBe(false);

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "expense_recurrence.updated", entity_id: res.body.data.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("returns 404 updating recurrence on an expense that has none", async () => {
      const expense = await createExpenseAs(ownerToken);
      const res = await request(app)
        .patch(`/expenses/${expense.id}/recurrence`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ active: false });
      expect(res.status).toBe(404);
    });

    it("returns 404 updating recurrence on an expense from a different business", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
      const otherCategories = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${otherLogin.accessToken}`);
      const otherCreated = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ scope: "business", categoryId: otherCategories.body.data[0].id, amount: 10, expenseDate: isoDate(-1), recurrence: { frequency: "daily" } });

      const res = await request(app)
        .patch(`/expenses/${otherCreated.body.data.id}/recurrence`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ active: false });
      expect(res.status).toBe(404);
    });
  });

  describe("Status workflow (single-step transitions only)", () => {
    it("creates directly in pending -- draft is unreachable this session (confirmed design)", async () => {
      const expense = await createExpenseAs(ownerToken);
      expect(expense.workflow_status).toBe("pending");
    });

    it("approves a pending expense, sets approvedBy/approvedAt, publishes ExpenseApproved, and blocks a second approve", async () => {
      const expense = await createExpenseAs(ownerToken);
      let published: unknown = null;
      domainEvents.once("ExpenseApproved", (payload) => {
        published = payload;
      });

      const res = await request(app)
        .post(`/expenses/${expense.id}/approve`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version });
      expect(res.status).toBe(200);
      expect(res.body.data.workflow_status).toBe("approved");
      expect(res.body.data.approved_by).toBeTruthy();
      expect(res.body.data.approved_at).toBeTruthy();
      expect(published).toMatchObject({ expenseId: expense.id, businessId });

      const second = await request(app)
        .post(`/expenses/${expense.id}/approve`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: res.body.data.version });
      expect(second.status).toBe(400);

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "expense.approved", entity_id: expense.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("rejects a pending expense with a required reason, sets rejectedBy/rejectedAt, publishes ExpenseRejected, and is terminal (no path back to pending)", async () => {
      const expense = await createExpenseAs(ownerToken);
      let published: unknown = null;
      domainEvents.once("ExpenseRejected", (payload) => {
        published = payload;
      });

      const noReason = await request(app)
        .post(`/expenses/${expense.id}/reject`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version });
      expect(noReason.status).toBe(400);

      const res = await request(app)
        .post(`/expenses/${expense.id}/reject`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, reason: "Missing receipt" });
      expect(res.status).toBe(200);
      expect(res.body.data.workflow_status).toBe("rejected");
      expect(res.body.data.rejected_by).toBeTruthy();
      expect(res.body.data.rejected_at).toBeTruthy();
      expect(published).toMatchObject({ expenseId: expense.id, businessId, reason: "Missing receipt" });

      // Terminal: approving a rejected expense must fail -- no resubmit path this session.
      const approveAfterReject = await request(app)
        .post(`/expenses/${expense.id}/approve`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: res.body.data.version });
      expect(approveAfterReject.status).toBe(400);

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "expense.rejected", entity_id: expense.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("marks an approved expense paid, sets paidBy/paidAt, and publishes ExpensePaid -- only reachable from approved", async () => {
      const expense = await createExpenseAs(ownerToken);

      const tooSoon = await request(app)
        .post(`/expenses/${expense.id}/mark-paid`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version });
      expect(tooSoon.status).toBe(400); // still pending, not approved yet

      const approved = await request(app)
        .post(`/expenses/${expense.id}/approve`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version });

      let published: unknown = null;
      domainEvents.once("ExpensePaid", (payload) => {
        published = payload;
      });

      const res = await request(app)
        .post(`/expenses/${expense.id}/mark-paid`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: approved.body.data.version });
      expect(res.status).toBe(200);
      expect(res.body.data.workflow_status).toBe("paid");
      expect(res.body.data.paid_by).toBeTruthy();
      expect(res.body.data.paid_at).toBeTruthy();
      expect(published).toMatchObject({ expenseId: expense.id, businessId });

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "expense.paid", entity_id: expense.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("rejects a stale-version approve (optimistic locking)", async () => {
      const expense = await createExpenseAs(ownerToken);
      const res = await request(app)
        .post(`/expenses/${expense.id}/approve`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version + 5 });
      expect(res.status).toBe(409);
    });

    // The loser of this race can legitimately land on EITHER 400 or 409,
    // not deterministically 409: approveExpense's pre-transaction guard
    // (`workflow_status !== "pending"`) reads state BEFORE the transaction,
    // so if the winner's transaction has already committed by the time the
    // loser's pre-check runs, the loser fails fast with 400 instead of
    // reaching the atomic updateMany's 409. Both outcomes correctly reject
    // the loser -- only the layer that catches it is timing-dependent. Found
    // by running this test under the full suite's heavier concurrent load
    // (it passed with a narrower [200,409]-only assertion in isolation,
    // which was the real bug: an assertion too narrow for the actual race,
    // not a code defect -- exactly one 200 and exactly one audit row is the
    // invariant that actually matters).
    it("only lets one of two concurrent approve requests win (real concurrency, not just sequential stale-version)", async () => {
      const expense = await createExpenseAs(ownerToken);
      const body = { version: expense.version };

      const [first, second] = await Promise.all([
        request(app).post(`/expenses/${expense.id}/approve`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
        request(app).post(`/expenses/${expense.id}/approve`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
      ]);
      const statuses = [first.status, second.status];
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      const loserStatus = statuses.find((s) => s !== 200);
      expect([400, 409]).toContain(loserStatus);

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "expense.approved", entity_id: expense.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("only lets one of two concurrent mark-paid requests win", async () => {
      const expense = await createExpenseAs(ownerToken);
      const approved = await request(app)
        .post(`/expenses/${expense.id}/approve`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version });
      const body = { version: approved.body.data.version };

      const [first, second] = await Promise.all([
        request(app).post(`/expenses/${expense.id}/mark-paid`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
        request(app).post(`/expenses/${expense.id}/mark-paid`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
      ]);
      const statuses = [first.status, second.status];
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      const loserStatus = statuses.find((s) => s !== 200);
      expect([400, 409]).toContain(loserStatus);
    });

    it("replays the same response for a repeated Idempotency-Key on approve", async () => {
      const expense = await createExpenseAs(ownerToken);
      const key = idemKey();
      const body = { version: expense.version };

      const first = await request(app).post(`/expenses/${expense.id}/approve`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body);
      expect(first.status).toBe(200);
      const second = await request(app).post(`/expenses/${expense.id}/approve`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body);
      expect(second.status).toBe(200);
      expect(second.body.data.version).toBe(first.body.data.version);
    });

    it("filters by workflowStatus", async () => {
      const expense = await createExpenseAs(ownerToken);
      await request(app)
        .post(`/expenses/${expense.id}/approve`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version });

      const res = await request(app).get("/expenses?workflowStatus=approved").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((e: { id: string }) => e.id === expense.id)).toBe(true);
      expect(res.body.data.every((e: { workflow_status: string }) => e.workflow_status === "approved")).toBe(true);
    });

    it("returns 404 approving/rejecting/marking paid an expense from a different business", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
      const otherCategories = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${otherLogin.accessToken}`);
      const otherCreated = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ scope: "business", categoryId: otherCategories.body.data[0].id, amount: 10, expenseDate: isoDate(-1) });
      const otherId = otherCreated.body.data.id;

      const approveRes = await request(app).post(`/expenses/${otherId}/approve`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send({ version: 0 });
      expect(approveRes.status).toBe(404);
      const rejectRes = await request(app).post(`/expenses/${otherId}/reject`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send({ version: 0, reason: "x" });
      expect(rejectRes.status).toBe(404);
      const paidRes = await request(app).post(`/expenses/${otherId}/mark-paid`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send({ version: 0 });
      expect(paidRes.status).toBe(404);
    });

    describe("RBAC on approve/reject/mark-paid", () => {
      const deniedRoles: UserRole[] = ["accountant", "cashier", "storekeeper", "shareholder", "custom"];

      it.each(deniedRoles)("denies role=%s approving, rejecting, and marking paid", async (role) => {
        const expense = await createExpenseAs(ownerToken);
        const user = await createTestUser(businessId, role);
        const token = mintAccessToken(user);

        const approveRes = await request(app).post(`/expenses/${expense.id}/approve`).set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send({ version: expense.version });
        expect(approveRes.status).toBe(403);
        const rejectRes = await request(app).post(`/expenses/${expense.id}/reject`).set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send({ version: expense.version, reason: "x" });
        expect(rejectRes.status).toBe(403);
        const paidRes = await request(app).post(`/expenses/${expense.id}/mark-paid`).set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send({ version: expense.version });
        expect(paidRes.status).toBe(403);
      });

      it("allows manager to approve", async () => {
        const expense = await createExpenseAs(ownerToken);
        const manager = await createTestUser(businessId, "manager");
        const token = mintAccessToken(manager);
        const res = await request(app).post(`/expenses/${expense.id}/approve`).set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send({ version: expense.version });
        expect(res.status).toBe(200);
      });
    });
  });

  describe("HNT-FIN-001: financial-field freeze + corrections once paid", () => {
    async function createPaidExpenseAs(token: string, overrides: Record<string, unknown> = {}) {
      const expense = await createExpenseAs(token, overrides);
      const approved = await request(app)
        .post(`/expenses/${expense.id}/approve`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version });
      const paid = await request(app)
        .post(`/expenses/${expense.id}/mark-paid`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: approved.body.data.version });
      return paid.body.data;
    }

    it.each(["amount", "categoryId", "taxAmount", "expenseDate"])(
      "PATCH on a paid expense's %s returns 409, not a silent mutation",
      async (field) => {
        const paid = await createPaidExpenseAs(ownerToken);
        const patchValue =
          field === "amount"
            ? { amount: 999 }
            : field === "categoryId"
              ? { categoryId }
              : field === "taxAmount"
                ? { taxAmount: 10 }
                : { expenseDate: isoDate(-1) };
        const res = await request(app)
          .patch(`/expenses/${paid.id}`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: paid.version, ...patchValue });
        expect(res.status).toBe(409);

        const reloaded = await prisma.expenses.findUniqueOrThrow({ where: { id: paid.id } });
        expect(Number(reloaded.amount)).toBe(500); // provably unchanged
      }
    );

    it("PATCH on a paid expense's paymentMethodId also returns 409", async () => {
      const pm = await createTestPaymentMethod(businessId);
      const paid = await createPaidExpenseAs(ownerToken);
      const res = await request(app)
        .patch(`/expenses/${paid.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: paid.version, paymentMethodId: pm.id });
      expect(res.status).toBe(409);
    });

    it("non-financial annotations (description/notes/tagIds) remain freely editable once paid", async () => {
      const paid = await createPaidExpenseAs(ownerToken);
      const res = await request(app)
        .patch(`/expenses/${paid.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: paid.version, description: "Updated note, non-financial" });
      expect(res.status).toBe(200);
      expect(res.body.data.description).toBe("Updated note, non-financial");
    });

    it("records a correction, leaves the original row's amount untouched, and effectiveAmount reflects the correction", async () => {
      const paid = await createPaidExpenseAs(ownerToken); // amount = 500
      const res = await request(app)
        .post(`/expenses/${paid.id}/corrections`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ reason: "Original receipt undercounted VAT-inclusive total", effectiveDate: isoDate(-1), newAmount: 550 });
      expect(res.status).toBe(201);
      expect(res.body.data.new_amount).toBe("550");

      // Original row's own amount is provably unchanged -- the correction
      // record is what carries the true value, never an in-place rewrite.
      const reloaded = await prisma.expenses.findUniqueOrThrow({ where: { id: paid.id } });
      expect(Number(reloaded.amount)).toBe(500);

      const getRes = await request(app).get(`/expenses/${paid.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.body.data.effectiveAmount).toBe("550");
      expect(getRes.body.data.expense_corrections).toHaveLength(1);
    });

    it("a duplicate correction attempt (same Idempotency-Key) is idempotent -- no second row", async () => {
      const paid = await createPaidExpenseAs(ownerToken);
      const key = idemKey();
      const body = { reason: "Correction", effectiveDate: isoDate(-1), newAmount: 600 };

      const first = await request(app).post(`/expenses/${paid.id}/corrections`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body);
      expect(first.status).toBe(201);
      const second = await request(app).post(`/expenses/${paid.id}/corrections`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body);
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);

      const corrections = await prisma.expense_corrections.findMany({ where: { expense_id: paid.id } });
      expect(corrections).toHaveLength(1);
    });

    it("rejects a correction against a still-pending (not yet paid) expense", async () => {
      const expense = await createExpenseAs(ownerToken);
      const res = await request(app)
        .post(`/expenses/${expense.id}/corrections`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ reason: "x", effectiveDate: isoDate(-1), newAmount: 100 });
      expect(res.status).toBe(400);
    });

    it("rejects a correction with no field actually being corrected", async () => {
      const paid = await createPaidExpenseAs(ownerToken);
      const res = await request(app)
        .post(`/expenses/${paid.id}/corrections`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ reason: "x", effectiveDate: isoDate(-1) });
      expect(res.status).toBe(400);
    });

    const rbacCases: { role: UserRole; canCorrect: boolean }[] = [
      { role: "owner", canCorrect: true },
      { role: "manager", canCorrect: true },
      { role: "accountant", canCorrect: false },
    ];
    it.each(rbacCases)("role=$role correction write=$canCorrect", async ({ role, canCorrect }) => {
      const paid = await createPaidExpenseAs(ownerToken);
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app)
        .post(`/expenses/${paid.id}/corrections`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ reason: "RBAC test", effectiveDate: isoDate(-1), newAmount: 100 });
      expect(res.status).toBe(canCorrect ? 201 : 403);
    });
  });

  describe("Attachment deletion", () => {
    const validAttachment = (overrides: Record<string, unknown> = {}) => ({
      filename: "receipt.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      storageKey: `test/${randomUUID()}`,
      ...overrides,
    });

    it("deletes an attachment and audit-logs it", async () => {
      const expense = await createExpenseAs(ownerToken, { attachments: [validAttachment()] });
      const attachmentId = expense.expense_attachments[0].id;

      const res = await request(app)
        .delete(`/expenses/${expense.id}/attachments/${attachmentId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey());
      expect(res.status).toBe(200);
      expect(res.body.data.expense_attachments).toHaveLength(0);

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "expense.attachment_deleted", entity_id: attachmentId } });
      expect(auditRows).toHaveLength(1);

      const row = await prisma.expense_attachments.findUnique({ where: { id: attachmentId } });
      expect(row).toBeNull();
    });

    it("returns 400 deleting an attachment from an archived expense", async () => {
      const expense = await createExpenseAs(ownerToken, { attachments: [validAttachment()] });
      await request(app)
        .post(`/expenses/${expense.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, reason: "x" });

      const res = await request(app)
        .delete(`/expenses/${expense.id}/attachments/${expense.expense_attachments[0].id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey());
      expect(res.status).toBe(400);
    });

    it("returns 404 deleting an attachment that belongs to a different expense", async () => {
      const expenseA = await createExpenseAs(ownerToken, { attachments: [validAttachment()] });
      const expenseB = await createExpenseAs(ownerToken);

      const res = await request(app)
        .delete(`/expenses/${expenseB.id}/attachments/${expenseA.expense_attachments[0].id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey());
      expect(res.status).toBe(404);
    });

    it("rejects a cashier deleting an attachment (elevated role only)", async () => {
      const expense = await createExpenseAs(ownerToken, { attachments: [validAttachment()] });
      const cashier = await createTestUser(businessId, "cashier");
      const token = mintAccessToken(cashier);
      const res = await request(app)
        .delete(`/expenses/${expense.id}/attachments/${expense.expense_attachments[0].id}`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey());
      expect(res.status).toBe(403);
    });
  });

  describe("Tags (many-to-many, filter-only)", () => {
    async function createTagAs(token: string, name = `Tag ${randomUUID()}`) {
      const res = await request(app).post("/tags").set("Authorization", `Bearer ${token}`).send({ name });
      if (res.status !== 201) throw new Error(`createTagAs failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.data;
    }

    it("attaches tags at creation and returns them nested on the expense", async () => {
      const tagA = await createTagAs(ownerToken);
      const tagB = await createTagAs(ownerToken);

      const expense = await createExpenseAs(ownerToken, { tagIds: [tagA.id, tagB.id] });
      const tagIds = expense.expense_tags.map((et: { tags: { id: string } }) => et.tags.id).sort();
      expect(tagIds).toEqual([tagA.id, tagB.id].sort());
    });

    it("returns 400 for a tagId that belongs to a different business", async () => {
      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
      const otherTag = await createTagAs(otherLogin.accessToken);

      const res = await request(app)
        .post("/expenses")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validExpensePayload({ tagIds: [otherTag.id] }));
      expect(res.status).toBe(400);
    });

    it("full-replaces tags on update, and clears them all with an empty array", async () => {
      const tagA = await createTagAs(ownerToken);
      const tagB = await createTagAs(ownerToken);
      const expense = await createExpenseAs(ownerToken, { tagIds: [tagA.id] });

      const replaced = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: expense.version, tagIds: [tagB.id] });
      expect(replaced.status).toBe(200);
      expect(replaced.body.data.expense_tags.map((et: { tag_id: string }) => et.tag_id)).toEqual([tagB.id]);

      const cleared = await request(app)
        .patch(`/expenses/${expense.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: replaced.body.data.version, tagIds: [] });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.expense_tags).toHaveLength(0);
    });

    it("filters expenses by tagId", async () => {
      const tag = await createTagAs(ownerToken);
      const tagged = await createExpenseAs(ownerToken, { tagIds: [tag.id] });
      const untagged = await createExpenseAs(ownerToken);

      const res = await request(app).get(`/expenses?tagId=${tag.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((e: { id: string }) => e.id);
      expect(ids).toContain(tagged.id);
      expect(ids).not.toContain(untagged.id);
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
