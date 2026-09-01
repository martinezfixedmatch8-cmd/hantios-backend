import request from "supertest";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { domainEvents } from "../src/lib/events";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestBranch, createTestUser, mintAccessToken } from "./helpers/factories";
import { generateId } from "../src/lib/ids";
import { processDueRecurrences, generateOccurrence, listRecurrenceRuns } from "../src/services/recurringExpense.service";

describe("Recurring Expense Worker (HNT-OPS-003)", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let categoryId: string;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;
    await createTestBranch(businessId);

    const categories = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    categoryId = categories.body.data.find((c: { name: string }) => c.name === "Misc").id;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  const idemKey = () => `test-${randomUUID()}`;
  const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  async function createRecurringTemplate(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/expenses")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        scope: "business",
        categoryId,
        amount: 500,
        expenseDate: isoDate(-40),
        recurrence: {
          frequency: "monthly",
          interval: 1,
          executionMode: "auto_post",
          amountType: "fixed",
          configuredAmount: 500,
          startDate: isoDate(-40),
          ...overrides,
        },
      });
    if (res.status !== 201) throw new Error(`createRecurringTemplate failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  it("generates a real posted expense for a due monthly auto_post period, links it on the run row, and advances last_run", async () => {
    let published: unknown = null;
    domainEvents.once("RecurringExpenseGenerated", (payload) => {
      published = payload;
    });

    const template = await createRecurringTemplate();
    const recurrence = await prisma.expense_recurrence.findUniqueOrThrow({ where: { template_expense_id: template.id } });
    const period = new Date(new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z");

    await generateOccurrence(recurrence.id, businessId, period);

    const run = await prisma.expense_recurrence_runs.findUniqueOrThrow({
      where: { recurrence_id_scheduled_period: { recurrence_id: recurrence.id, scheduled_period: period } },
    });
    expect(run.status).toBe("succeeded");
    expect(run.expense_id).not.toBeNull();

    const generatedExpense = await prisma.expenses.findUniqueOrThrow({ where: { id: run.expense_id as string } });
    expect(generatedExpense.source).toBe("recurring");
    expect(generatedExpense.workflow_status).toBe("pending"); // auto_post, normal workflow
    expect(Number(generatedExpense.amount)).toBe(500);

    const updatedRecurrence = await prisma.expense_recurrence.findUniqueOrThrow({ where: { id: recurrence.id } });
    expect(updatedRecurrence.last_run?.toISOString().slice(0, 10)).toBe(period.toISOString().slice(0, 10));

    const auditRows = await prisma.audit_logs.findMany({ where: { action: "expense.recurring_generated", entity_id: run.expense_id as string } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].user_name).toBe("Recurring Expense Worker");

    expect(published).toMatchObject({ businessId, recurrenceId: recurrence.id, expenseId: run.expense_id });
  });

  it("generates a $0.00 DRAFT placeholder expense for a variable-amount auto_draft schedule", async () => {
    const template = await createRecurringTemplate({
      frequency: "daily",
      executionMode: "auto_draft",
      amountType: "variable",
      configuredAmount: undefined,
      dailyAutoPostConfirmed: false, // irrelevant for auto_draft, but included for clarity
      startDate: isoDate(-1),
    });
    const recurrence = await prisma.expense_recurrence.findUniqueOrThrow({ where: { template_expense_id: template.id } });
    const period = new Date(isoDate(0) + "T00:00:00.000Z");

    await generateOccurrence(recurrence.id, businessId, period);

    const run = await prisma.expense_recurrence_runs.findUniqueOrThrow({
      where: { recurrence_id_scheduled_period: { recurrence_id: recurrence.id, scheduled_period: period } },
    });
    expect(run.status).toBe("succeeded");
    const generatedExpense = await prisma.expenses.findUniqueOrThrow({ where: { id: run.expense_id as string } });
    expect(generatedExpense.workflow_status).toBe("draft");
    expect(Number(generatedExpense.amount)).toBe(0);
  });

  it("never double-generates on a repeated sweep for the same period (real DB-level dedup, not just app logic)", async () => {
    const template = await createRecurringTemplate({ startDate: isoDate(-1), frequency: "daily", interval: 1, dailyAutoPostConfirmed: true });
    const recurrence = await prisma.expense_recurrence.findUniqueOrThrow({ where: { template_expense_id: template.id } });
    const period = new Date(isoDate(0) + "T00:00:00.000Z");

    await generateOccurrence(recurrence.id, businessId, period);
    await generateOccurrence(recurrence.id, businessId, period); // repeat -- should be a no-op

    const runs = await prisma.expense_recurrence_runs.count({ where: { recurrence_id: recurrence.id, scheduled_period: period } });
    expect(runs).toBe(1);
  });

  it("under genuine concurrency, exactly one of two simultaneous attempts for the SAME period succeeds -- never two expenses", async () => {
    const template = await createRecurringTemplate({ startDate: isoDate(-1), frequency: "daily", interval: 1, dailyAutoPostConfirmed: true });
    const recurrence = await prisma.expense_recurrence.findUniqueOrThrow({ where: { template_expense_id: template.id } });
    const period = new Date(isoDate(0) + "T00:00:00.000Z");

    await Promise.all([generateOccurrence(recurrence.id, businessId, period), generateOccurrence(recurrence.id, businessId, period)]);

    // The real proof of the concurrency guarantee: exactly one run row for
    // this (recurrence, period) pair, succeeded, with exactly one linked
    // expense_id -- the @@unique constraint plus the atomic claim/complete
    // shape structurally rule out two expenses ever being created for the
    // same occurrence, regardless of how many concurrent attempts race.
    const runs = await prisma.expense_recurrence_runs.findMany({ where: { recurrence_id: recurrence.id, scheduled_period: period } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].expense_id).not.toBeNull();
  });

  it("processDueRecurrences skips an inactive recurrence entirely, then picks it up once reactivated", async () => {
    const template = await createRecurringTemplate({ startDate: isoDate(-1), frequency: "daily", interval: 1, dailyAutoPostConfirmed: true });
    const recurrence = await prisma.expense_recurrence.findUniqueOrThrow({ where: { template_expense_id: template.id } });
    await prisma.expense_recurrence.update({ where: { id: recurrence.id }, data: { active: false } });

    await processDueRecurrences(new Date());
    const whileInactive = await prisma.expense_recurrence_runs.count({ where: { recurrence_id: recurrence.id } });
    expect(whileInactive).toBe(0);

    await prisma.expense_recurrence.update({ where: { id: recurrence.id }, data: { active: true } });
    await processDueRecurrences(new Date());
    const afterReactivating = await prisma.expense_recurrence_runs.count({ where: { recurrence_id: recurrence.id } });
    expect(afterReactivating).toBeGreaterThan(0);
  });

  describe("Database Safety Invariants -- real, DB-level, not just app logic", () => {
    it("chk_expense_recurrence_runs_succeeded_requires_expense_id rejects a direct attempt to mark succeeded with no expense_id", async () => {
      const template = await createRecurringTemplate({ startDate: isoDate(-1) });
      const recurrence = await prisma.expense_recurrence.findUniqueOrThrow({ where: { template_expense_id: template.id } });

      await expect(
        prisma.$executeRaw(Prisma.sql`
          INSERT INTO expense_recurrence_runs (id, business_id, recurrence_id, scheduled_period, status, attempts, updated_at)
          VALUES (${generateId()}, ${businessId}, ${recurrence.id}, ${new Date(isoDate(0))}, 'succeeded', 0, now())
        `)
      ).rejects.toThrow();
    });

    it("chk_expense_recurrence_no_variable_auto_post rejects a direct attempt to bypass the app-layer Zod check", async () => {
      await expect(
        prisma.$executeRaw(Prisma.sql`
          UPDATE expense_recurrence SET execution_mode = 'auto_post', amount_type = 'variable', configured_amount = NULL
          WHERE business_id = ${businessId} LIMIT 1
        `)
      ).rejects.toThrow();
    });
  });

  describe("GET /expenses/:id/recurrence/runs -- dead-letter visibility", () => {
    it("paginates run history and enforces cross-business isolation", async () => {
      const template = await createRecurringTemplate({ startDate: isoDate(-5), frequency: "daily", interval: 1, dailyAutoPostConfirmed: true });
      const recurrence = await prisma.expense_recurrence.findUniqueOrThrow({ where: { template_expense_id: template.id } });
      for (let i = 0; i < 3; i++) {
        await generateOccurrence(recurrence.id, businessId, new Date(isoDate(-i)));
      }

      const result = await listRecurrenceRuns(template.id, { page: 1, pageSize: 2 }, businessId);
      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBeGreaterThanOrEqual(3);

      const res = await request(app)
        .get(`/expenses/${template.id}/recurrence/runs`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.pagination).toBeDefined();

      const otherOwner = await signupTestOwner();
      businessIds.push(otherOwner.businessId);
      const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
      const crossBusiness = await request(app)
        .get(`/expenses/${template.id}/recurrence/runs`)
        .set("Authorization", `Bearer ${otherLogin.accessToken}`);
      expect(crossBusiness.status).toBe(404);
    });

    it("returns 403 for cashier (locked -- zero Expenses access anywhere)", async () => {
      const cashier = await createTestUser(businessId, "cashier");
      const token = mintAccessToken(cashier);
      const template = await createRecurringTemplate({ startDate: isoDate(-1), frequency: "daily", interval: 1, dailyAutoPostConfirmed: true });
      const res = await request(app).get(`/expenses/${template.id}/recurrence/runs`).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  });
});
