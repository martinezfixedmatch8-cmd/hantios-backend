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
} from "./helpers/factories";
import { generatePayrollForBusiness } from "../src/services/payroll.service";
import { getEligibleSalesForPeriod } from "../src/services/commission.service";
import type { UserRole } from "@prisma/client";

const idemKey = () => `test-${randomUUID()}`;

// Always safely in the past relative to real wall-clock "now" -- matches
// the established Session B precedent (avoids any month-boundary edge
// case near the start/end of "today"'s own month).
function monthsAgo(n: number): { year: number; month: number } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
function midMonth(period: { year: number; month: number }, day = 15): Date {
  return new Date(Date.UTC(period.year, period.month - 1, day, 12, 0, 0));
}

describe("Module 12 Session C -- Sales Attribution & Commission Engine", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerId: string;
  let ownerToken: string;
  let branchId: string;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    ownerId = owner.ownerId;
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

  async function createEmployee(name = `Commission Employee ${randomUUID()}`, token = ownerToken) {
    const res = await request(app)
      .post("/employees")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ name, phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}` });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function setPercentageCompensation(employeeId: string, commissionRate: number, token = ownerToken) {
    const res = await request(app)
      .post(`/employees/${employeeId}/compensation`)
      .set("Authorization", `Bearer ${token}`)
      .send({ compensationModel: "PERCENTAGE", effectiveFrom: "2020-01-01", config: { commissionRate } });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function stockedProduct(quantity: number) {
    const product = await createTestProduct(businessId, { costPrice: 10, sellingPrice: 100 });
    await createTestBranchInventory(businessId, branchId, product.id, { quantity });
    return product;
  }

  // Creates a real sale via the actual API (total = quantity x 100 per the
  // fixed stockedProduct sellingPrice above), then backdates its timestamp
  // to a chosen moment -- mirrors sale.test.ts's own established
  // backdateSale helper, since POST /sales always stamps timestamp: now().
  async function createBackdatedSale(
    quantity: number,
    at: Date,
    overrides: Partial<{ salespersonEmployeeId: string; token: string }> = {}
  ) {
    const product = await stockedProduct(quantity + 5);
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${overrides.token ?? ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        branchId,
        items: [{ productId: product.id, quantity }],
        ...(overrides.salespersonEmployeeId ? { salespersonEmployeeId: overrides.salespersonEmployeeId } : {}),
      });
    expect(res.status).toBe(201);
    await prisma.sales.update({ where: { id: res.body.data.id }, data: { timestamp: at } });
    return prisma.sales.findUniqueOrThrow({ where: { id: res.body.data.id } });
  }

  describe("Sale Attribution", () => {
    it("sets attribution at creation and logs a real sale_attribution_events row (source: creation)", async () => {
      const employee = await createEmployee();
      const product = await stockedProduct(10);
      const res = await request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ branchId, items: [{ productId: product.id, quantity: 1 }], salespersonEmployeeId: employee.id });
      expect(res.status).toBe(201);
      expect(res.body.data.salesperson_employee_id).toBe(employee.id);

      const events = await prisma.sale_attribution_events.findMany({ where: { sale_id: res.body.data.id } });
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe("creation");
      expect(events[0].previous_employee_id).toBeNull();
      expect(events[0].new_employee_id).toBe(employee.id);
      expect(events[0].changed_by).toBe(ownerId);
    });

    it("rejects a salespersonEmployeeId belonging to a different business", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);
      const otherEmployee = await createEmployee(`Other Business Employee ${randomUUID()}`, otherLogin.accessToken);
      const product = await stockedProduct(10);

      const res = await request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ branchId, items: [{ productId: product.id, quantity: 1 }], salespersonEmployeeId: otherEmployee.id });
      expect(res.status).toBe(404);
    });

    it("corrects attribution via the dedicated endpoint, logging a new event with previous/new ids", async () => {
      const fatima = await createEmployee("Fatima");
      const ahmed = await createEmployee("Ahmed");
      const sale = await createBackdatedSale(1, new Date(), { salespersonEmployeeId: fatima.id });

      const res = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: ahmed.id, reason: "Data-entry correction" });
      expect(res.status).toBe(200);
      expect(res.body.data.salesperson_employee_id).toBe(ahmed.id);

      const events = await prisma.sale_attribution_events.findMany({ where: { sale_id: sale.id }, orderBy: { changed_at: "asc" } });
      expect(events).toHaveLength(2);
      expect(events[1].source).toBe("correction");
      expect(events[1].previous_employee_id).toBe(fatima.id);
      expect(events[1].new_employee_id).toBe(ahmed.id);
    });

    it("can explicitly clear attribution (employeeId: null)", async () => {
      const employee = await createEmployee();
      const sale = await createBackdatedSale(1, new Date(), { salespersonEmployeeId: employee.id });

      const res = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: null, reason: "Was attributed in error" });
      expect(res.status).toBe(200);
      expect(res.body.data.salesperson_employee_id).toBeNull();
    });

    it("rejects a stale version with 409", async () => {
      const employee = await createEmployee();
      const sale = await createBackdatedSale(1, new Date());

      const first = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employee.id, reason: "First correction" });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employee.id, reason: "Stale retry" });
      expect(second.status).toBe(409);
    });

    it("bundles the full attribution history onto GET /sales/:id, in order", async () => {
      const fatima = await createEmployee("Fatima History");
      const ahmed = await createEmployee("Ahmed History");
      const sale = await createBackdatedSale(1, new Date(), { salespersonEmployeeId: fatima.id });
      await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: ahmed.id, reason: "Correction" });

      const getRes = await request(app).get(`/sales/${sale.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.sale_attribution_events).toHaveLength(2);
      expect(getRes.body.data.sale_attribution_events[0].source).toBe("creation");
      expect(getRes.body.data.sale_attribution_events[1].source).toBe("correction");
    });

    const rbacCases: { role: UserRole; canCorrect: boolean }[] = [
      { role: "owner", canCorrect: true },
      { role: "manager", canCorrect: true },
      { role: "cashier", canCorrect: false },
      { role: "accountant", canCorrect: false },
    ];
    it.each(rbacCases)("role=$role attribution correction=$canCorrect", async ({ role, canCorrect }) => {
      const employee = await createEmployee();
      const sale = await createBackdatedSale(1, new Date());
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const res = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employee.id, reason: "RBAC test" });
      expect(res.status).toBe(canCorrect ? 200 : 403);
    });

    it("a refund reversal row copies attribution forward WITHOUT writing a new attribution event", async () => {
      const employee = await createEmployee();
      const sale = await createBackdatedSale(1, new Date(), { salespersonEmployeeId: employee.id });
      // Refund requires the sale to be from a PRIOR business day.
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 2);
      await prisma.sales.update({ where: { id: sale.id }, data: { timestamp: yesterday } });

      const refundRes = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, reason: "Customer return", items: [{ lineIndex: 0, returnedQuantity: 1, restockable: false }] });
      expect(refundRes.status).toBe(201);
      expect(refundRes.body.data.salesperson_employee_id).toBe(employee.id);

      const reversalEvents = await prisma.sale_attribution_events.findMany({ where: { sale_id: refundRes.body.data.id } });
      expect(reversalEvents).toHaveLength(0);
    });
  });

  describe("Commission eligibility (getEligibleSalesForPeriod)", () => {
    it("includes a completed sale at its full total", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(2);
      await createBackdatedSale(1, midMonth(period), { salespersonEmployeeId: employee.id }); // total = 100

      const total = await getEligibleSalesForPeriod(businessId, employee.id, period.year, period.month, "Africa/Nairobi");
      expect(total.toString()).toBe("100");
    });

    it("excludes a voided sale entirely", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(3);
      const sale = await createBackdatedSale(1, midMonth(period), { salespersonEmployeeId: employee.id });
      // Void requires same-business-day -- restore "now" for the void call itself.
      await prisma.sales.update({ where: { id: sale.id }, data: { timestamp: new Date() } });
      const reloaded = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });

      const voidRes = await request(app)
        .post(`/sales/${sale.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: reloaded.version, reason: "test void" });
      expect(voidRes.status).toBe(200);
      // Put the (now-voided) sale's timestamp back into the target period.
      await prisma.sales.update({ where: { id: sale.id }, data: { timestamp: midMonth(period) } });

      const total = await getEligibleSalesForPeriod(businessId, employee.id, period.year, period.month, "Africa/Nairobi");
      expect(total.toString()).toBe("0");
    });

    it("nets a same-period refund to zero", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(4);
      const sale = await createBackdatedSale(2, midMonth(period, 10), { salespersonEmployeeId: employee.id }); // total = 200
      // Refund requires a PRIOR business day, then both the original and
      // its reversal are pushed into the SAME target period.
      await prisma.sales.update({ where: { id: sale.id }, data: { timestamp: new Date(Date.now() - 2 * 86400000) } });
      const reloaded = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
      const refundRes = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: reloaded.version, reason: "same-period refund", items: [{ lineIndex: 0, returnedQuantity: 2, restockable: false }] });
      expect(refundRes.status).toBe(201);
      await prisma.sales.update({ where: { id: sale.id }, data: { timestamp: midMonth(period, 10) } });
      await prisma.sales.update({ where: { id: refundRes.body.data.id }, data: { timestamp: midMonth(period, 12) } });

      const total = await getEligibleSalesForPeriod(businessId, employee.id, period.year, period.month, "Africa/Nairobi");
      expect(total.toString()).toBe("0");
    });

    it("a later-period refund leaves the original period untouched and lands as a negative entry in its own period", async () => {
      const employee = await createEmployee();
      const originalPeriod = monthsAgo(6);
      const refundPeriod = monthsAgo(5);
      const sale = await createBackdatedSale(1, midMonth(originalPeriod), { salespersonEmployeeId: employee.id }); // total = 100

      await prisma.sales.update({ where: { id: sale.id }, data: { timestamp: new Date(Date.now() - 2 * 86400000) } });
      const reloaded = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
      const refundRes = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: reloaded.version, reason: "later-period refund", items: [{ lineIndex: 0, returnedQuantity: 1, restockable: false }] });
      expect(refundRes.status).toBe(201);
      await prisma.sales.update({ where: { id: sale.id }, data: { timestamp: midMonth(originalPeriod) } });
      await prisma.sales.update({ where: { id: refundRes.body.data.id }, data: { timestamp: midMonth(refundPeriod) } });

      const originalTotal = await getEligibleSalesForPeriod(businessId, employee.id, originalPeriod.year, originalPeriod.month, "Africa/Nairobi");
      expect(originalTotal.toString()).toBe("100"); // untouched

      const refundPeriodTotal = await getEligibleSalesForPeriod(businessId, employee.id, refundPeriod.year, refundPeriod.month, "Africa/Nairobi");
      expect(refundPeriodTotal.toString()).toBe("-100");
    });
  });

  describe("PERCENTAGE payroll generation", () => {
    it("calculates commission from eligible sales x rate, with a real calculation_breakdown snapshot", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(7);
      await setPercentageCompensation(employee.id, 5); // 5%
      await createBackdatedSale(10, midMonth(period), { salespersonEmployeeId: employee.id }); // total = 1000
      // 1000 x 5% = 50

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.compensation_model).toBe("PERCENTAGE");
      expect(record.amount.toString()).toBe("50");
      const breakdown = record.calculation_breakdown as unknown as { type: string; eligibleSales: string; commissionRate: string };
      expect(breakdown.type).toBe("PERCENTAGE");
      expect(breakdown.eligibleSales).toBe("1000");
      expect(breakdown.commissionRate).toBe("5");
    });

    it("a post-generation new sale does not rewrite an already-generated payroll record", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(8);
      await setPercentageCompensation(employee.id, 10);
      await createBackdatedSale(1, midMonth(period), { salespersonEmployeeId: employee.id }); // total = 100, commission = 10

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const original = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(original.amount.toString()).toBe("10");

      await createBackdatedSale(5, midMonth(period, 20), { salespersonEmployeeId: employee.id });

      const stillOriginal = await prisma.payroll_records.findUniqueOrThrow({ where: { id: original.id } });
      expect(stillOriginal.amount.toString()).toBe("10"); // unchanged -- the Calculation Snapshot held
    });

    it("zero eligible sales produces a legitimate $0.00 record, never a skip", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(9);
      await setPercentageCompensation(employee.id, 5);
      // No sales at all attributed to this employee in this period.

      const result = await generatePayrollForBusiness(businessId, period.year, period.month);
      expect(result.skipped.some((s) => s.employeeId === employee.id)).toBe(false);
      expect(result.generated.some((g) => g.employeeId === employee.id)).toBe(true);

      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.amount.toString()).toBe("0");
    });
  });

  describe("FIXED_PLUS_PERCENTAGE payroll generation", () => {
    it("calculates fixedBase + commission correctly, with a full calculation_breakdown snapshot", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(10);
      const compRes = await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "FIXED_PLUS_PERCENTAGE", effectiveFrom: "2020-01-01", config: { fixedBase: 200, commissionRate: 5 } });
      expect(compRes.status).toBe(201);
      await createBackdatedSale(10, midMonth(period), { salespersonEmployeeId: employee.id }); // total = 1000, commission = 50

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.compensation_model).toBe("FIXED_PLUS_PERCENTAGE");
      expect(record.amount.toString()).toBe("250"); // 200 + 50
      const breakdown = record.calculation_breakdown as unknown as { type: string; fixedBase: string; commission: string };
      expect(breakdown.type).toBe("FIXED_PLUS_PERCENTAGE");
      expect(breakdown.fixedBase).toBe("200");
      expect(breakdown.commission).toBe("50");
    });
  });

  describe("compensation_config Zod boundary -- PERCENTAGE/FIXED_PLUS_PERCENTAGE writable, others still rejected", () => {
    it("accepts PERCENTAGE and FIXED_PLUS_PERCENTAGE", async () => {
      const e1 = await createEmployee();
      const res1 = await request(app)
        .post(`/employees/${e1.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "PERCENTAGE", effectiveFrom: "2020-01-01", config: { commissionRate: "5.00" } });
      expect(res1.status).toBe(201);

      const e2 = await createEmployee();
      const res2 = await request(app)
        .post(`/employees/${e2.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "FIXED_PLUS_PERCENTAGE", effectiveFrom: "2020-01-01", config: { fixedBase: "100.00", commissionRate: "3.00" } });
      expect(res2.status).toBe(201);
    });

    // Module 12 Session D widened this boundary for real -- FIXED_PLUS_TIME/
    // CONTRACT/CUSTOM are now genuinely writable (see tests/payrollSessionD.
    // test.ts for their own real config coverage), so only PIECE_RATE
    // remains structurally unwritable (confirmed NOT CALCULABLE YET -- no
    // Output/Production-tracking source exists anywhere in this repo).
    // Updated here rather than left stale, per the same "keep test names
    // accurate to real behavior" discipline this repo already follows --
    // Session D's own approved decisions are exactly what changed this.
    const stillRejectedModels = ["PIECE_RATE"];
    it.each(stillRejectedModels)("still rejects %s -- structurally unwritable through this endpoint", async (model) => {
      const employee = await createEmployee();
      const res = await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: model, effectiveFrom: "2020-01-01", config: { rate: 5 } });
      expect(res.status).toBe(400);
    });
  });

  describe("Commission Adjustments", () => {
    it("creates a manual correction without ever mutating the already-issued payroll_records.amount", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(11);
      await setPercentageCompensation(employee.id, 5);
      await createBackdatedSale(10, midMonth(period), { salespersonEmployeeId: employee.id }); // amount = 50
      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });

      const res = await request(app)
        .post("/commission-adjustments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, payrollRecordId: record.id, deltaAmount: -20, reason: "Sale reattributed to another employee" });
      expect(res.status).toBe(201);
      expect(res.body.data.delta_amount).toBe("-20");

      const reloaded = await prisma.payroll_records.findUniqueOrThrow({ where: { id: record.id } });
      expect(reloaded.amount.toString()).toBe("50"); // permanently unchanged
    });

    it("rejects a payrollRecordId that belongs to a different employee", async () => {
      const employeeA = await createEmployee();
      const employeeB = await createEmployee();
      const period = monthsAgo(12);
      await setPercentageCompensation(employeeA.id, 5);
      await generatePayrollForBusiness(businessId, period.year, period.month);
      const recordA = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employeeA.id, period_year: period.year, period_month: period.month },
      });

      const res = await request(app)
        .post("/commission-adjustments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employeeB.id, payrollRecordId: recordA.id, deltaAmount: 10, reason: "mismatch test" });
      expect(res.status).toBe(400);
    });

    const rbacCases: { role: UserRole; canWrite: boolean }[] = [
      { role: "owner", canWrite: true },
      { role: "manager", canWrite: true },
      { role: "accountant", canWrite: false },
    ];
    it.each(rbacCases)("role=$role commission adjustment write=$canWrite", async ({ role, canWrite }) => {
      const employee = await createEmployee();
      const period = monthsAgo(13);
      await setPercentageCompensation(employee.id, 5);
      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const res = await request(app)
        .post("/commission-adjustments")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, payrollRecordId: record.id, deltaAmount: 5, reason: "RBAC test" });
      expect(res.status).toBe(canWrite ? 201 : 403);
    });
  });

  describe("Compensation Policies", () => {
    it("publishes a policy, then a new version of the SAME type supersedes the old one", async () => {
      const v1 = await request(app)
        .post("/compensation-policies")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ policyType: "COMMISSION", version: "1.0", title: "Sales Commission Policy", content: "5% of eligible completed sales.", effectiveFrom: "2020-01-01" });
      expect(v1.status).toBe(201);
      expect(v1.body.data.status).toBe("active");

      const v2 = await request(app)
        .post("/compensation-policies")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ policyType: "COMMISSION", version: "1.1", title: "Sales Commission Policy", content: "Updated: 6% of eligible completed sales.", effectiveFrom: "2020-02-01" });
      expect(v2.status).toBe(201);
      expect(v2.body.data.status).toBe("active");

      const reloadedV1 = await prisma.compensation_policies.findUniqueOrThrow({ where: { id: v1.body.data.id } });
      expect(reloadedV1.status).toBe("superseded");
    });

    it("owner/manager can record an acknowledgement on an employee's behalf", async () => {
      const employee = await createEmployee();
      const policy = await request(app)
        .post("/compensation-policies")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ policyType: "GENERAL", version: "1.0", title: "General Compensation Policy", content: "How pay works at this business.", effectiveFrom: "2020-01-01" });

      const ackRes = await request(app)
        .post(`/compensation-policies/${policy.body.data.id}/acknowledge`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ employeeId: employee.id });
      expect(ackRes.status).toBe(201);
      expect(ackRes.body.data.employee_id).toBe(employee.id);
    });

    it("a linked employee can self-acknowledge; an unlinked non-owner/manager user cannot acknowledge on someone else's behalf", async () => {
      const cashierUser = await createTestUser(businessId, "cashier");
      const cashierToken = mintAccessToken(cashierUser);
      const linkedEmployee = await createEmployee();
      await request(app)
        .patch(`/employees/${linkedEmployee.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: linkedEmployee.version, userId: cashierUser.id });

      const policy = await request(app)
        .post("/compensation-policies")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ policyType: "GENERAL", version: "1.0", title: "Self-Ack Test Policy", content: "Content.", effectiveFrom: "2020-01-01" });

      const selfAck = await request(app)
        .post(`/compensation-policies/${policy.body.data.id}/acknowledge`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ employeeId: linkedEmployee.id });
      expect(selfAck.status).toBe(201);

      const otherEmployee = await createEmployee();
      const forbiddenAck = await request(app)
        .post(`/compensation-policies/${policy.body.data.id}/acknowledge`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ employeeId: otherEmployee.id });
      expect(forbiddenAck.status).toBe(403);
    });

    it("re-acknowledging the same policy is idempotent -- no duplicate row", async () => {
      const employee = await createEmployee();
      const policy = await request(app)
        .post("/compensation-policies")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ policyType: "GENERAL", version: "1.0", title: "Idempotent Ack Test", content: "Content.", effectiveFrom: "2020-01-01" });

      await request(app).post(`/compensation-policies/${policy.body.data.id}/acknowledge`).set("Authorization", `Bearer ${ownerToken}`).send({ employeeId: employee.id });
      await request(app).post(`/compensation-policies/${policy.body.data.id}/acknowledge`).set("Authorization", `Bearer ${ownerToken}`).send({ employeeId: employee.id });

      const acks = await prisma.compensation_policy_acknowledgements.findMany({ where: { employee_id: employee.id, policy_id: policy.body.data.id } });
      expect(acks).toHaveLength(1);
    });

    it("historical integrity: an acknowledgement of an old version stays pointed at that old version after a new version supersedes it", async () => {
      const employee = await createEmployee();
      const v1 = await request(app)
        .post("/compensation-policies")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ policyType: "ATTENDANCE", version: "1.0", title: "Attendance Policy", content: "v1 content.", effectiveFrom: "2020-01-01" });
      await request(app).post(`/compensation-policies/${v1.body.data.id}/acknowledge`).set("Authorization", `Bearer ${ownerToken}`).send({ employeeId: employee.id });

      await request(app)
        .post("/compensation-policies")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ policyType: "ATTENDANCE", version: "2.0", title: "Attendance Policy", content: "v2 content.", effectiveFrom: "2020-02-01" });

      const ack = await prisma.compensation_policy_acknowledgements.findUniqueOrThrow({
        where: { employee_id_policy_id: { employee_id: employee.id, policy_id: v1.body.data.id } },
      });
      expect(ack.policy_id).toBe(v1.body.data.id); // still the OLD version, never repointed
    });

    const policyRbacCases: { role: UserRole; canWrite: boolean; canView: boolean }[] = [
      { role: "owner", canWrite: true, canView: true },
      { role: "manager", canWrite: true, canView: true },
      { role: "accountant", canWrite: false, canView: true },
      { role: "cashier", canWrite: false, canView: false },
    ];
    it.each(policyRbacCases)("role=$role compensation-policy write=$canWrite view=$canView", async ({ role, canWrite, canView }) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const writeRes = await request(app)
        .post("/compensation-policies")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ policyType: "GENERAL", version: `rbac-${randomUUID()}`, title: "RBAC Test", content: "Content.", effectiveFrom: "2020-01-01" });
      expect(writeRes.status).toBe(canWrite ? 201 : 403);

      const viewRes = await request(app).get("/compensation-policies").set("Authorization", `Bearer ${token}`);
      expect(viewRes.status).toBe(canView ? 200 : 403);
    });
  });

  describe("Cross-tenant isolation", () => {
    it("cannot correct attribution on, or view, a sale from a different business", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);
      const otherBranch = await createTestBranch(other.businessId);
      const otherProduct = await createTestProduct(other.businessId, { costPrice: 10, sellingPrice: 50 });
      await createTestBranchInventory(other.businessId, otherBranch.id, otherProduct.id, { quantity: 10 });
      const otherSaleRes = await request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ branchId: otherBranch.id, items: [{ productId: otherProduct.id, quantity: 1 }] });
      expect(otherSaleRes.status).toBe(201);

      const getRes = await request(app).get(`/sales/${otherSaleRes.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(404);

      const attrRes = await request(app)
        .post(`/sales/${otherSaleRes.body.data.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, employeeId: null, reason: "cross-tenant attempt" });
      expect(attrRes.status).toBe(404);
    });

    it("cannot create a commission adjustment against a payroll record from a different business", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);
      const otherEmployee = await createEmployee(`Other Business Employee ${randomUUID()}`, otherLogin.accessToken);
      await setPercentageCompensation(otherEmployee.id, 5, otherLogin.accessToken);
      const period = monthsAgo(14);
      await generatePayrollForBusiness(other.businessId, period.year, period.month);
      const otherRecord = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: other.businessId, employee_id: otherEmployee.id, period_year: period.year, period_month: period.month },
      });

      const res = await request(app)
        .post("/commission-adjustments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: otherEmployee.id, payrollRecordId: otherRecord.id, deltaAmount: 10, reason: "cross-tenant attempt" });
      expect(res.status).toBe(404);
    });
  });
});
