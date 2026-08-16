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
  createTestBranch,
  createTestProduct,
  createTestBranchInventory,
} from "./helpers/factories";
import { generatePayrollForBusiness } from "../src/services/payroll.service";
import { getApprovedHoursForPeriod } from "../src/services/attendance.service";
import type { UserRole } from "@prisma/client";

const idemKey = () => `test-${randomUUID()}`;

// Same wall-clock-safe period helper every Module 12 test file already
// uses (Sessions B/C) -- avoids both the "not later than today" attendance
// guard and any month-boundary edge case near the start/end of "today"'s
// own month.
function monthsAgo(n: number): { year: number; month: number } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
function dateInPeriod(period: { year: number; month: number }, day: number): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function midMonth(period: { year: number; month: number }, day = 15): Date {
  return new Date(Date.UTC(period.year, period.month - 1, day, 12, 0, 0));
}

describe("Module 12 Session D -- Final Completion", () => {
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

  async function createEmployee(name = `Session D Employee ${randomUUID()}`, token = ownerToken) {
    const res = await request(app)
      .post("/employees")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ name, phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}` });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function setCompensation(employeeId: string, compensationModel: string, config: Record<string, unknown>, token = ownerToken) {
    const res = await request(app)
      .post(`/employees/${employeeId}/compensation`)
      .set("Authorization", `Bearer ${token}`)
      .send({ compensationModel, effectiveFrom: "2020-01-01", config });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function recordApprovedDay(employeeId: string, workDate: string, hoursWorked: number, token = ownerToken) {
    const res = await request(app)
      .post("/attendance")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ employeeId, workDate, hoursWorked });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function stockedProduct(quantity: number) {
    const product = await createTestProduct(businessId, { costPrice: 10, sellingPrice: 100 });
    await createTestBranchInventory(businessId, branchId, product.id, { quantity });
    return product;
  }

  async function createBackdatedSale(quantity: number, at: Date, salespersonEmployeeId?: string) {
    const product = await stockedProduct(quantity + 5);
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        branchId,
        items: [{ productId: product.id, quantity }],
        ...(salespersonEmployeeId ? { salespersonEmployeeId } : {}),
      });
    expect(res.status).toBe(201);
    await prisma.sales.update({ where: { id: res.body.data.id }, data: { timestamp: at } });
    return prisma.sales.findUniqueOrThrow({ where: { id: res.body.data.id } });
  }

  describe("FIXED_PLUS_TIME", () => {
    it("splits normal/overtime hours PER DAY using the business's own configured threshold/multiplier, with a full calculation_breakdown snapshot", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(2);
      await setCompensation(employee.id, "FIXED_PLUS_TIME", {
        fixedAmount: 100,
        hourlyRate: 10,
        overtimeThresholdHours: 8,
        overtimeMultiplier: 1.5,
      });
      // Day 1: 10h -> 8 normal + 2 overtime. Day 2: 6h -> 6 normal + 0 overtime.
      await recordApprovedDay(employee.id, dateInPeriod(period, 5), 10);
      await recordApprovedDay(employee.id, dateInPeriod(period, 6), 6);

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.compensation_model).toBe("FIXED_PLUS_TIME");
      // normalPay = 14h x 10 = 140; overtimePay = 2h x 10 x 1.5 = 30; + fixedAmount 100 = 270
      expect(record.amount.toString()).toBe("270");
      const breakdown = record.calculation_breakdown as unknown as {
        type: string;
        fixedAmount: string;
        normalHours: string;
        overtimeHours: string;
        normalPay: string;
        overtimePay: string;
      };
      expect(breakdown.type).toBe("FIXED_PLUS_TIME");
      expect(breakdown.fixedAmount).toBe("100");
      expect(breakdown.normalHours).toBe("14");
      expect(breakdown.overtimeHours).toBe("2");
      expect(breakdown.normalPay).toBe("140");
      expect(breakdown.overtimePay).toBe("30");
    });

    it("is fully configurable, never hardcoded -- a different threshold/multiplier produces a different result for the identical hours worked", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(3);
      // Lower threshold (4h) and a higher multiplier (2x) than the previous test.
      await setCompensation(employee.id, "FIXED_PLUS_TIME", {
        fixedAmount: 0,
        hourlyRate: 10,
        overtimeThresholdHours: 4,
        overtimeMultiplier: 2,
      });
      await recordApprovedDay(employee.id, dateInPeriod(period, 5), 10); // 4 normal + 6 overtime

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      // normalPay = 4 x 10 = 40; overtimePay = 6 x 10 x 2 = 120; total = 160
      expect(record.amount.toString()).toBe("160");
    });

    it("a day at or below the threshold has zero overtime hours", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(4);
      await setCompensation(employee.id, "FIXED_PLUS_TIME", { fixedAmount: 0, hourlyRate: 10, overtimeThresholdHours: 8, overtimeMultiplier: 1.5 });
      await recordApprovedDay(employee.id, dateInPeriod(period, 5), 8); // exactly at threshold

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      const breakdown = record.calculation_breakdown as unknown as { overtimeHours: string };
      expect(breakdown.overtimeHours).toBe("0");
      expect(record.amount.toString()).toBe("80"); // 8h x 10, no overtime
    });
  });

  describe("CONTRACT", () => {
    it("calculates amount = contractAmount / contractPeriodMonths for MONTHLY schedule, with a full calculation_breakdown snapshot", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(5);
      await setCompensation(employee.id, "CONTRACT", { contractAmount: 12000, contractPeriodMonths: 12, paymentSchedule: "MONTHLY" });

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.compensation_model).toBe("CONTRACT");
      expect(record.amount.toString()).toBe("1000");
      const breakdown = record.calculation_breakdown as unknown as { type: string; contractAmount: string; contractPeriodMonths: number; paymentSchedule: string };
      expect(breakdown.type).toBe("CONTRACT");
      expect(breakdown.contractAmount).toBe("12000");
      expect(breakdown.contractPeriodMonths).toBe(12);
      expect(breakdown.paymentSchedule).toBe("MONTHLY");
    });

    it("rejects a non-MONTHLY paymentSchedule -- milestone-based payment is confirmed deferred", async () => {
      const employee = await createEmployee();
      const res = await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "CONTRACT", effectiveFrom: "2020-01-01", config: { contractAmount: 12000, contractPeriodMonths: 12, paymentSchedule: "MILESTONE" } });
      expect(res.status).toBe(400);
    });
  });

  describe("CUSTOM v1 -- Composable Compensation", () => {
    it("fixedComponent alone reuses FIXED_MONTHLY's own logic exactly", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(6);
      await setCompensation(employee.id, "CUSTOM", { fixedComponent: { monthlySalary: 300 } });

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.compensation_model).toBe("CUSTOM");
      expect(record.amount.toString()).toBe("300");
      const breakdown = record.calculation_breakdown as unknown as { type: string; components: { type: string; amount: string }[] };
      expect(breakdown.type).toBe("CUSTOM");
      expect(breakdown.components).toHaveLength(1);
      expect(breakdown.components[0]).toMatchObject({ type: "fixed", amount: "300" });
    });

    it("hourlyComponent alone reuses HOURLY's own getApprovedHoursForPeriod exactly", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(7);
      await setCompensation(employee.id, "CUSTOM", { hourlyComponent: { hourlyRate: 20 } });
      await recordApprovedDay(employee.id, dateInPeriod(period, 10), 5);

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.amount.toString()).toBe("100"); // 5h x 20
      const breakdown = record.calculation_breakdown as unknown as { components: { type: string; hours: string; amount: string }[] };
      expect(breakdown.components[0]).toMatchObject({ type: "hourly", hours: "5", amount: "100" });
    });

    it("percentageComponent alone reuses PERCENTAGE's own getEligibleSalesForPeriod exactly", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(8);
      await setCompensation(employee.id, "CUSTOM", { percentageComponent: { commissionRate: 5 } });
      await createBackdatedSale(10, midMonth(period), employee.id); // total = 1000, 5% = 50

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.amount.toString()).toBe("50");
      const breakdown = record.calculation_breakdown as unknown as { components: { type: string; amount: string }[] };
      expect(breakdown.components[0]).toMatchObject({ type: "percentage", amount: "50" });
    });

    it("combines all three components -- sum is correct, all three appear in the breakdown", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(9);
      await setCompensation(employee.id, "CUSTOM", {
        fixedComponent: { monthlySalary: 100 },
        hourlyComponent: { hourlyRate: 10 },
        percentageComponent: { commissionRate: 5 },
      });
      await recordApprovedDay(employee.id, dateInPeriod(period, 10), 4); // 40
      await createBackdatedSale(5, midMonth(period), employee.id); // total = 500, 5% = 25

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.amount.toString()).toBe("165"); // 100 + 40 + 25
      const breakdown = record.calculation_breakdown as unknown as { components: unknown[]; total: string };
      expect(breakdown.components).toHaveLength(3);
      expect(breakdown.total).toBe("165");
    });

    it("rejects a CUSTOM config with zero components", async () => {
      const employee = await createEmployee();
      const res = await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "CUSTOM", effectiveFrom: "2020-01-01", config: {} });
      expect(res.status).toBe(400);
    });
  });

  describe("payroll_reversals -- PAID correction ledger", () => {
    async function createPaidRecord(salary: number, period: { year: number; month: number }) {
      const employee = await createEmployee();
      await setCompensation(employee.id, "FIXED_MONTHLY", { monthlySalary: salary });
      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      const payRes = await request(app)
        .post(`/payroll/${record.id}/mark-paid`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: record.version });
      expect(payRes.status).toBe(200);
      return { employee, record };
    }

    it("creates a reversal against a PAID record without ever mutating payroll_records.amount, and effectiveAmount reflects it", async () => {
      const period = monthsAgo(10);
      const { record } = await createPaidRecord(1000, period);

      const res = await request(app)
        .post(`/payroll/${record.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaAmount: -150, reason: "Overpaid -- correcting after payment" });
      expect(res.status).toBe(201);
      expect(res.body.data.delta_amount).toBe("-150");

      const reloaded = await prisma.payroll_records.findUniqueOrThrow({ where: { id: record.id } });
      expect(reloaded.amount.toString()).toBe("1000"); // permanently unchanged

      const getRes = await request(app).get(`/payroll/${record.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.effectiveAmount).toBe("850"); // 1000 - 150
    });

    it("stacks multiple reversals correctly in effectiveAmount", async () => {
      const period = monthsAgo(11);
      const { record } = await createPaidRecord(500, period);

      await request(app)
        .post(`/payroll/${record.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaAmount: -50, reason: "First correction" });
      await request(app)
        .post(`/payroll/${record.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaAmount: 20, reason: "Second correction, partial offset" });

      const getRes = await request(app).get(`/payroll/${record.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.body.data.effectiveAmount).toBe("470"); // 500 - 50 + 20
    });

    // HNT-PAY-003 remediation -- the cumulative bound.
    it("accepts a reversal landing exactly at the bound (effectiveAmount = 0)", async () => {
      const period = monthsAgo(15);
      const { record } = await createPaidRecord(200, period);
      const res = await request(app)
        .post(`/payroll/${record.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaAmount: -200, reason: "Full reversal, lands exactly at zero" });
      expect(res.status).toBe(201);

      const getRes = await request(app).get(`/payroll/${record.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.body.data.effectiveAmount).toBe("0");
    });

    it("rejects a reversal that would land one cent past the bound (effectiveAmount < 0)", async () => {
      const period = monthsAgo(16);
      const { record } = await createPaidRecord(200, period);
      const res = await request(app)
        .post(`/payroll/${record.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaAmount: -200.01, reason: "Would push effectiveAmount to -0.01" });
      expect(res.status).toBe(400);

      const getRes = await request(app).get(`/payroll/${record.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.body.data.effectiveAmount).toBe("200"); // unchanged, the rejected attempt created nothing
    });

    it("no separate cap on the upside -- a positive correction can legitimately exceed the original amount", async () => {
      const period = monthsAgo(17);
      const { record } = await createPaidRecord(200, period);
      const res = await request(app)
        .post(`/payroll/${record.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaAmount: 500, reason: "Back-pay correction, legitimately exceeds the original amount" });
      expect(res.status).toBe(201);

      const getRes = await request(app).get(`/payroll/${record.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.body.data.effectiveAmount).toBe("700"); // 200 + 500, no ceiling
    });

    it("under genuine concurrency, two simultaneous reversals whose combined delta would cross the bound -- exactly one succeeds, effectiveAmount never goes negative", async () => {
      const period = monthsAgo(18);
      const { record } = await createPaidRecord(100, period);

      const [first, second] = await Promise.all([
        request(app)
          .post(`/payroll/${record.id}/reversals`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ deltaAmount: -60, reason: "Concurrent reversal A" }),
        request(app)
          .post(`/payroll/${record.id}/reversals`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ deltaAmount: -60, reason: "Concurrent reversal B" }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 400]);

      const reversals = await prisma.payroll_reversals.findMany({ where: { payroll_record_id: record.id } });
      expect(reversals).toHaveLength(1);

      const getRes = await request(app).get(`/payroll/${record.id}`).set("Authorization", `Bearer ${ownerToken}`);
      const effectiveAmount = Number(getRes.body.data.effectiveAmount);
      expect(effectiveAmount).toBeGreaterThanOrEqual(0); // the real, authoritative proof
      expect(effectiveAmount).toBe(40); // 100 - 60
    });

    it("rejects a reversal against a still-PENDING record -- corrections to pending records go through commission_adjustments/normal correction, not this ledger", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(12);
      await setCompensation(employee.id, "FIXED_MONTHLY", { monthlySalary: 400 });
      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });

      const res = await request(app)
        .post(`/payroll/${record.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaAmount: -50, reason: "attempted correction on pending" });
      expect(res.status).toBe(400);
    });

    it("rejects a zero deltaAmount", async () => {
      const period = monthsAgo(13);
      const { record } = await createPaidRecord(300, period);
      const res = await request(app)
        .post(`/payroll/${record.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaAmount: 0, reason: "should be rejected" });
      expect(res.status).toBe(400);
    });

    const rbacCases: { role: UserRole; canWrite: boolean }[] = [
      { role: "owner", canWrite: true },
      { role: "manager", canWrite: true },
      { role: "accountant", canWrite: false },
      { role: "cashier", canWrite: false },
    ];
    it.each(rbacCases)("role=$role payroll reversal write=$canWrite", async ({ role, canWrite }) => {
      const period = monthsAgo(14);
      const { record } = await createPaidRecord(300, period);
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const res = await request(app)
        .post(`/payroll/${record.id}/reversals`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaAmount: -10, reason: "RBAC test" });
      expect(res.status).toBe(canWrite ? 201 : 403);
    });

    it("cross-tenant isolation -- cannot create a reversal against a payroll record from a different business", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);
      const otherEmployeeRes = await request(app)
        .post("/employees")
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ name: "Other Business Employee", phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}` });
      await request(app)
        .post(`/employees/${otherEmployeeRes.body.data.id}/compensation`)
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .send({ compensationModel: "FIXED_MONTHLY", effectiveFrom: "2020-01-01", config: { monthlySalary: 200 } });
      const period = monthsAgo(15);
      await generatePayrollForBusiness(other.businessId, period.year, period.month);
      const otherRecord = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: other.businessId, employee_id: otherEmployeeRes.body.data.id, period_year: period.year, period_month: period.month },
      });
      await request(app)
        .post(`/payroll/${otherRecord.id}/mark-paid`)
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: otherRecord.version });

      const res = await request(app)
        .post(`/payroll/${otherRecord.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaAmount: -10, reason: "cross-tenant attempt" });
      expect(res.status).toBe(404);
    });
  });

  describe("Automatic Commission Reallocation", () => {
    async function preparePendingCommissionPair(period: { year: number; month: number }, rateA = 5, rateB = 5) {
      const employeeA = await createEmployee();
      const employeeB = await createEmployee();
      await setCompensation(employeeA.id, "PERCENTAGE", { commissionRate: rateA });
      await setCompensation(employeeB.id, "PERCENTAGE", { commissionRate: rateB });
      const sale = await createBackdatedSale(10, midMonth(period), employeeA.id); // total = 1000
      await generatePayrollForBusiness(businessId, period.year, period.month);
      const recordA = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employeeA.id, period_year: period.year, period_month: period.month },
      });
      const recordB = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employeeB.id, period_year: period.year, period_month: period.month },
      });
      return { employeeA, employeeB, sale, recordA, recordB };
    }

    // State A: both payroll_records PENDING -> automatic, atomic, value-preserving reallocation.
    it("State A: both records PENDING -- automatically reallocates the exact sale contribution, preserving total commission", async () => {
      const period = monthsAgo(16);
      const { employeeA, employeeB, sale, recordA } = await preparePendingCommissionPair(period, 5, 5);
      // recordA's own stored commissionRate (5%) x sale.total (1000) = 50 is
      // the value-preserving amount X, computed ONCE from the ORIGINAL
      // record's own snapshot -- never re-derived, never using employeeB's
      // own rate even though it happens to be identical here.

      const res = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employeeB.id, reason: "Reattributing to the correct salesperson" });
      expect(res.status).toBe(200);
      expect(res.body.data.reallocation.status).toBe("success");
      expect(res.body.data.reallocation.amount).toBe("50");

      const adjustments = await prisma.commission_adjustments.findMany({ where: { sale_id: sale.id }, orderBy: { delta_amount: "asc" } });
      expect(adjustments).toHaveLength(2);
      expect(adjustments[0].employee_id).toBe(employeeA.id);
      expect(adjustments[0].delta_amount.toString()).toBe("-50");
      expect(adjustments[1].employee_id).toBe(employeeB.id);
      expect(adjustments[1].delta_amount.toString()).toBe("50");

      // Total commission across both affected payroll records is unchanged:
      // recordA's own stored amount is untouched (still 50), recordB's own
      // stored amount is untouched too (whatever its own independent
      // generation produced) -- the transfer lives entirely in the
      // adjustment ledger, never in payroll_records.amount itself.
      const reloadedA = await prisma.payroll_records.findUniqueOrThrow({ where: { id: recordA.id } });
      expect(reloadedA.amount.toString()).toBe("50"); // never mutated
    });

    // State B: either side PAID -- no automatic reallocation.
    it("State B: the ORIGINAL record already PAID -- no auto-reallocation; attribution still succeeds", async () => {
      const period = monthsAgo(17);
      const { employeeB, sale, recordA } = await preparePendingCommissionPair(period, 5, 5);
      await request(app)
        .post(`/payroll/${recordA.id}/mark-paid`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: recordA.version });

      const res = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employeeB.id, reason: "Reattributing after original was already paid" });
      expect(res.status).toBe(200);
      expect(res.body.data.reallocation.status).toBe("skipped_paid");
      expect(res.body.data.salesperson_employee_id).toBe(employeeB.id); // attribution correction itself still applied

      const adjustments = await prisma.commission_adjustments.findMany({ where: { sale_id: sale.id } });
      expect(adjustments).toHaveLength(0); // no automatic reallocation happened

      const events = await prisma.sale_attribution_events.findMany({ where: { sale_id: sale.id }, orderBy: { changed_at: "asc" } });
      expect(events).toHaveLength(2);
      expect(events[1].source).toBe("correction"); // still fully auditable
    });

    it("State B: the NEW record already PAID -- no auto-reallocation either", async () => {
      const period = monthsAgo(18);
      const { employeeB, sale, recordB } = await preparePendingCommissionPair(period, 5, 5);
      await request(app)
        .post(`/payroll/${recordB.id}/mark-paid`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: recordB.version });

      const res = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employeeB.id, reason: "New side already paid" });
      expect(res.status).toBe(200);
      expect(res.body.data.reallocation.status).toBe("skipped_paid");

      const adjustments = await prisma.commission_adjustments.findMany({ where: { sale_id: sale.id } });
      expect(adjustments).toHaveLength(0);
    });

    // State C: either record missing -- no silent creation, no partial reallocation.
    it("State C: the NEW employee has no payroll_records row for this period -- no silent creation, no partial reallocation", async () => {
      const period = monthsAgo(19);
      const employeeA = await createEmployee();
      const employeeB = await createEmployee(); // never gets a compensation structure -> never generates a record
      await setCompensation(employeeA.id, "PERCENTAGE", { commissionRate: 5 });
      const sale = await createBackdatedSale(10, midMonth(period), employeeA.id);
      await generatePayrollForBusiness(businessId, period.year, period.month);
      const recordA = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employeeA.id, period_year: period.year, period_month: period.month },
      });
      const missingRecordB = await prisma.payroll_records.findFirst({
        where: { business_id: businessId, employee_id: employeeB.id, period_year: period.year, period_month: period.month },
      });
      expect(missingRecordB).toBeNull(); // confirmed genuinely missing before the attempt

      const res = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employeeB.id, reason: "Reattributing to an employee with no payroll record yet" });
      expect(res.status).toBe(200);
      expect(res.body.data.reallocation.status).toBe("skipped_missing_records");
      expect(res.body.data.salesperson_employee_id).toBe(employeeB.id); // attribution correction itself still applied, remains fully auditable

      const stillMissing = await prisma.payroll_records.findFirst({
        where: { business_id: businessId, employee_id: employeeB.id, period_year: period.year, period_month: period.month },
      });
      expect(stillMissing).toBeNull(); // NEVER silently created

      const adjustments = await prisma.commission_adjustments.findMany({ where: { sale_id: sale.id } });
      expect(adjustments).toHaveLength(0); // no partial reallocation

      const reloadedA = await prisma.payroll_records.findUniqueOrThrow({ where: { id: recordA.id } });
      expect(reloadedA.amount.toString()).toBe("50"); // original side untouched
    });

    it("State C: a first-time attribution (no previous employee) is not_applicable, never attempted as a reallocation", async () => {
      const employee = await createEmployee();
      const sale = await createBackdatedSale(1, new Date());
      const res = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employee.id, reason: "First attribution, no prior employee" });
      expect(res.status).toBe(200);
      expect(res.body.data.reallocation.status).toBe("not_applicable");
    });

    // State D: transaction failure -- full atomic rollback, including the reallocation.
    it("State D: a concurrency conflict rolls back the WHOLE transaction, including any reallocation work -- no partial adjustments survive", async () => {
      const period = monthsAgo(20);
      const { employeeB, sale } = await preparePendingCommissionPair(period, 5, 5);

      const firstAttempt = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employeeB.id, reason: "First correction" });
      expect(firstAttempt.status).toBe(200);
      const adjustmentsAfterFirst = await prisma.commission_adjustments.findMany({ where: { sale_id: sale.id } });
      expect(adjustmentsAfterFirst).toHaveLength(2); // the legitimate first reallocation succeeded

      // A second attempt reusing the SAME (now-stale) version must fail
      // atomically -- the sales.updateMany guard throws conflict() BEFORE
      // any reallocation logic runs at all, so no additional adjustment
      // rows should ever be created from this failed attempt.
      const secondAttempt = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employeeB.id, reason: "Stale retry, should fail atomically" });
      expect(secondAttempt.status).toBe(409);

      const adjustmentsAfterSecond = await prisma.commission_adjustments.findMany({ where: { sale_id: sale.id } });
      expect(adjustmentsAfterSecond).toHaveLength(2); // unchanged -- the failed attempt left NO trace
    });

    it("skips reallocation when either side is not a commission-driven model", async () => {
      const period = monthsAgo(21);
      const employeeA = await createEmployee();
      const employeeB = await createEmployee();
      await setCompensation(employeeA.id, "PERCENTAGE", { commissionRate: 5 });
      await setCompensation(employeeB.id, "FIXED_MONTHLY", { monthlySalary: 500 }); // not commission-driven
      const sale = await createBackdatedSale(10, midMonth(period), employeeA.id);
      await generatePayrollForBusiness(businessId, period.year, period.month);

      const res = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: employeeB.id, reason: "New side is FIXED_MONTHLY, not commission-driven" });
      expect(res.status).toBe(200);
      expect(res.body.data.reallocation.status).toBe("skipped_non_commission_model");

      const adjustments = await prisma.commission_adjustments.findMany({ where: { sale_id: sale.id } });
      expect(adjustments).toHaveLength(0);
    });
  });

  describe("Self-service attendance", () => {
    async function linkedCashier(employeeId?: string) {
      const cashierUser = await createTestUser(businessId, "cashier");
      const cashierToken = mintAccessToken(cashierUser);
      if (employeeId) {
        const employee = await prisma.employees.findUniqueOrThrow({ where: { id: employeeId } });
        await request(app)
          .patch(`/employees/${employeeId}`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ version: employee.version, userId: cashierUser.id });
      }
      return { cashierUser, cashierToken };
    }

    it("creates a record with status:recorded (NOT approved) -- self-reported attendance is not self-approved", async () => {
      const employee = await createEmployee();
      const { cashierToken, cashierUser } = await linkedCashier(employee.id);
      const period = monthsAgo(2);

      const res = await request(app)
        .post("/attendance/self")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ workDate: dateInPeriod(period, 20), hoursWorked: 7 });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("recorded");
      expect(res.body.data.employee_id).toBe(employee.id);
      expect(res.body.data.recorded_by).toBe(cashierUser.id);
      expect(res.body.data.approved_by).toBeNull();
      expect(res.body.data.approved_at).toBeNull();
    });

    it("returns a clean 404 for a user with no linked, active employee record", async () => {
      const { cashierToken } = await linkedCashier(); // deliberately not linked
      const res = await request(app)
        .post("/attendance/self")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ workDate: "2024-01-15", hoursWorked: 8 });
      expect(res.status).toBe(404);
    });

    it("self-reported (recorded, not approved) hours are excluded from getApprovedHoursForPeriod -- still requires separate approval", async () => {
      const employee = await createEmployee();
      const { cashierToken } = await linkedCashier(employee.id);
      const period = monthsAgo(3);

      await request(app)
        .post("/attendance/self")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ workDate: dateInPeriod(period, 10), hoursWorked: 8 });

      const approvedHours = await getApprovedHoursForPeriod(businessId, employee.id, period.year, period.month);
      expect(approvedHours.toString()).toBe("0"); // not counted -- self-service does NOT self-approve
    });

    it("employeeId is never client-suppliable -- resolves exclusively from the caller's own session", async () => {
      const employeeA = await createEmployee();
      const employeeB = await createEmployee();
      const { cashierToken, cashierUser } = await linkedCashier(employeeA.id);

      const res = await request(app)
        .post("/attendance/self")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("Idempotency-Key", idemKey())
        // Attempting to smuggle a different employeeId in the body -- must be ignored.
        .send({ employeeId: employeeB.id, workDate: "2024-02-01", hoursWorked: 6 } as unknown as Record<string, unknown>);
      expect(res.status).toBe(201);
      expect(res.body.data.employee_id).toBe(employeeA.id); // resolved from the session, never the body
      void cashierUser;
    });
  });
});
