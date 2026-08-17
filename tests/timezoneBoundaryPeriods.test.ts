import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import {
  signupTestOwner,
  loginTestOwner,
  createTestBranch,
  createTestProduct,
  createTestBranchInventory,
} from "./helpers/factories";
import { generatePayrollForBusiness } from "../src/services/payroll.service";
import { getEligibleSalesForPeriod } from "../src/services/commission.service";
import { getApprovedHoursForPeriod } from "../src/services/attendance.service";
import { getBusinessMonthBounds } from "../src/lib/businessTime";

// Batch 3 remediation (HNT2-COM-001 + HNT-PAY-001 + finding #5) -- proves
// the real fix end to end, through the actual API/service call paths, not
// just businessTime.unit.test.ts's own unit-level coverage of
// getBusinessMonthBounds in isolation.

const idemKey = () => `test-${randomUUID()}`;

// Safely in the past relative to real wall-clock "now" -- same established
// precedent as salesCommission.test.ts's own monthsAgo.
function monthsAgo(n: number): { year: number; month: number } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

describe("Batch 3: business-timezone-correct commission/payroll period boundaries", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let branchId: string;

  beforeAll(async () => {
    // Africa/Nairobi (UTC+3, no DST) -- signupTestOwner's own default
    // (country: "KE"), matching the rest of the Module 12 test suite.
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

  async function createEmployee(name = `TZ Employee ${randomUUID()}`, token = ownerToken) {
    const res = await request(app)
      .post("/employees")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ name, phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}` });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function setPercentageCompensation(employeeId: string, commissionRate: number, effectiveFrom = "2020-01-01", token = ownerToken) {
    const res = await request(app)
      .post(`/employees/${employeeId}/compensation`)
      .set("Authorization", `Bearer ${token}`)
      .send({ compensationModel: "PERCENTAGE", effectiveFrom, config: { commissionRate } });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function stockedProduct(quantity: number) {
    const product = await createTestProduct(businessId, { costPrice: 10, sellingPrice: 100 });
    await createTestBranchInventory(businessId, branchId, product.id, { quantity });
    return product;
  }

  async function createBackdatedSale(quantity: number, at: Date, overrides: Partial<{ salespersonEmployeeId: string }> = {}) {
    const product = await stockedProduct(quantity + 5);
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
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

  describe("Commission eligibility -- sales.timestamp is a real instant, boundary must be business-local", () => {
    it("a sale one second before the Nairobi-local month boundary belongs to the PREVIOUS period", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(3);
      const { start } = getBusinessMonthBounds("Africa/Nairobi", period.year, period.month);
      const oneSecondBefore = new Date(start.getTime() - 1000);
      await createBackdatedSale(1, oneSecondBefore, { salespersonEmployeeId: employee.id }); // total = 100

      const currentPeriodTotal = await getEligibleSalesForPeriod(businessId, employee.id, period.year, period.month, "Africa/Nairobi");
      expect(currentPeriodTotal.toString()).toBe("0");

      const prevMonth = period.month === 1 ? 12 : period.month - 1;
      const prevYear = period.month === 1 ? period.year - 1 : period.year;
      const previousPeriodTotal = await getEligibleSalesForPeriod(businessId, employee.id, prevYear, prevMonth, "Africa/Nairobi");
      expect(previousPeriodTotal.toString()).toBe("100");
    });

    it("a sale one second after the Nairobi-local month boundary belongs to the CURRENT period -- this is exactly the case the old UTC-only boundary got wrong", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(4);
      const { start } = getBusinessMonthBounds("Africa/Nairobi", period.year, period.month);
      const oneSecondAfter = new Date(start.getTime() + 1000);
      // Under the OLD (buggy) Date.UTC(year, month-1, 1) boundary, this
      // exact instant (Aug 1 00:00:01 Nairobi local = Jul 31 21:00:01 UTC)
      // would have been < the naive UTC boundary and wrongly excluded from
      // August. Confirmed it's correctly INCLUDED now.
      await createBackdatedSale(1, oneSecondAfter, { salespersonEmployeeId: employee.id }); // total = 100

      const total = await getEligibleSalesForPeriod(businessId, employee.id, period.year, period.month, "Africa/Nairobi");
      expect(total.toString()).toBe("100");
    });

    it("the exact boundary instant itself belongs to the NEW period (inclusive start)", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(5);
      const { start } = getBusinessMonthBounds("Africa/Nairobi", period.year, period.month);
      await createBackdatedSale(1, start, { salespersonEmployeeId: employee.id });

      const total = await getEligibleSalesForPeriod(businessId, employee.id, period.year, period.month, "Africa/Nairobi");
      expect(total.toString()).toBe("100");
    });
  });

  describe("America/New_York (DST-observing) -- resolves the real seasonal offset, not a fixed one", () => {
    it("a sale straddling the boundary is assigned correctly during EDT (summer)", async () => {
      const dstOwner = await signupTestOwner();
      businessIds.push(dstOwner.businessId);
      await prisma.businesses.update({ where: { id: dstOwner.businessId }, data: { timezone: "America/New_York" } });
      const dstLogin = await loginTestOwner(dstOwner.email, dstOwner.password, dstOwner.deviceId);
      const dstBranch = await createTestBranch(dstOwner.businessId);

      const product = await createTestProduct(dstOwner.businessId, { costPrice: 10, sellingPrice: 100 });
      await createTestBranchInventory(dstOwner.businessId, dstBranch.id, product.id, { quantity: 10 });
      const saleRes = await request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${dstLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ branchId: dstBranch.id, items: [{ productId: product.id, quantity: 1 }] });
      expect(saleRes.status).toBe(201);

      // A safely-past July (EDT, UTC-4) -- one second after local midnight
      // on the 1st, which is 04:00:01 UTC. A fixed EST (UTC-5) assumption
      // would have wrongly placed this at 23:00:01 the PREVIOUS local day.
      const period = monthsAgo(6);
      const { start } = getBusinessMonthBounds("America/New_York", period.year, period.month);
      const oneSecondAfter = new Date(start.getTime() + 1000);
      await prisma.sales.update({ where: { id: saleRes.body.data.id }, data: { timestamp: oneSecondAfter } });

      const employee = await createEmployee("DST Employee", dstLogin.accessToken);
      await prisma.sales.update({ where: { id: saleRes.body.data.id }, data: { salesperson_employee_id: employee.id } });

      const total = await getEligibleSalesForPeriod(dstOwner.businessId, employee.id, period.year, period.month, "America/New_York");
      expect(total.toString()).toBe("100");
    });
  });

  describe("Payroll generation and commission eligibility agree on the same period for the same timestamp", () => {
    it("a PERCENTAGE payroll record generated for a boundary-straddling sale lands in the correct business-local period", async () => {
      const employee = await createEmployee();
      await setPercentageCompensation(employee.id, 10);
      const period = monthsAgo(7);
      const { start } = getBusinessMonthBounds("Africa/Nairobi", period.year, period.month);
      const oneSecondAfter = new Date(start.getTime() + 1000);
      await createBackdatedSale(1, oneSecondAfter, { salespersonEmployeeId: employee.id }); // total = 100

      const result = await generatePayrollForBusiness(businessId, period.year, period.month);
      expect(result.generated).toHaveLength(1);
      const record = await prisma.payroll_records.findUniqueOrThrow({ where: { id: result.generated[0].payrollRecordId } });
      expect(record.period_year).toBe(period.year);
      expect(record.period_month).toBe(period.month);
      expect(record.amount.toString()).toBe("10"); // 10% of 100
    });
  });

  describe("Refund netting is unaffected by the boundary-precision fix", () => {
    it("a same-period refund at a Nairobi boundary still nets to exactly zero", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(8);
      const { start } = getBusinessMonthBounds("Africa/Nairobi", period.year, period.month);
      const justInsidePeriod = new Date(start.getTime() + 2000);
      const sale = await createBackdatedSale(2, new Date(Date.now() - 2 * 86400000), { salespersonEmployeeId: employee.id }); // total = 200, needs a real prior-day timestamp to refund
      const reloaded = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
      const refundRes = await request(app)
        .post(`/sales/${sale.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: reloaded.version, reason: "boundary refund test", items: [{ lineIndex: 0, returnedQuantity: 2, restockable: false }] });
      expect(refundRes.status).toBe(201);

      // Push both the original and its reversal into the SAME target
      // period, straddling the real boundary instant.
      await prisma.sales.update({ where: { id: sale.id }, data: { timestamp: justInsidePeriod } });
      await prisma.sales.update({ where: { id: refundRes.body.data.id }, data: { timestamp: new Date(justInsidePeriod.getTime() + 1000) } });

      const total = await getEligibleSalesForPeriod(businessId, employee.id, period.year, period.month, "Africa/Nairobi");
      expect(total.toString()).toBe("0");
    });
  });

  describe("Automatic Commission Reallocation (setSaleAttribution) uses the same business-local period as commission eligibility", () => {
    it("reattributing a boundary-straddling sale finds the correct period's payroll records on both sides", async () => {
      const originalEmployee = await createEmployee();
      const newEmployee = await createEmployee();
      await setPercentageCompensation(originalEmployee.id, 10);
      await setPercentageCompensation(newEmployee.id, 10);

      const period = monthsAgo(9);
      const { start } = getBusinessMonthBounds("Africa/Nairobi", period.year, period.month);
      const oneSecondAfter = new Date(start.getTime() + 1000);
      const sale = await createBackdatedSale(1, oneSecondAfter, { salespersonEmployeeId: originalEmployee.id }); // total = 100

      // Generate payroll for BOTH employees for the correct business-local
      // period the sale actually belongs to -- both must exist for
      // reallocation to be a "success," not "skipped_missing_records."
      await generatePayrollForBusiness(businessId, period.year, period.month);

      const attributionRes = await request(app)
        .post(`/sales/${sale.id}/attribution`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: sale.version, employeeId: newEmployee.id, reason: "reassign for boundary test" });
      expect(attributionRes.status).toBe(200);
      // Proves setSaleAttribution's own period derivation (getBusinessLocalYear/
      // getBusinessLocalMonth) landed on the SAME period generatePayrollForBusiness
      // just generated records for -- "skipped_missing_records" would mean
      // the two systems disagreed on which period this sale belongs to,
      // exactly the class of bug this fix closes.
      expect(attributionRes.body.data.reallocation.status).toBe("success");
      expect(attributionRes.body.data.reallocation.amount).toBe("10");
    });
  });

  describe("Regression: the three @db.Date sites remain plain calendar-date comparisons, deliberately NOT business-timezone-shifted", () => {
    it("attendance_records.work_date at exactly the 1st of a period is counted in that period for a Nairobi-timezone business (no instant shift applied)", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(10);
      // work_date is a bare calendar date -- constructed exactly like the
      // rest of this codebase's own @db.Date convention (UTC midnight
      // labeling the literal calendar date, dateOnlyString's own
      // precedent), never a business-timezone-shifted instant.
      const workDate = new Date(Date.UTC(period.year, period.month - 1, 1)).toISOString().slice(0, 10);
      await prisma.attendance_records.create({
        data: {
          id: randomUUID(),
          business_id: businessId,
          employee_id: employee.id,
          work_date: new Date(Date.UTC(period.year, period.month - 1, 1)),
          hours_worked: 8,
          status: "approved",
          recorded_by: (await prisma.users.findFirstOrThrow({ where: { business_id: businessId, role: "owner" } })).id,
        },
      });

      const hours = await getApprovedHoursForPeriod(businessId, employee.id, period.year, period.month);
      expect(hours.toString()).toBe("8");
      void workDate; // constructed for readability/documentation only
    });

    it("employee_compensation.effective_from at exactly the 1st of a period is picked up as effective for that period's payroll generation, for a Nairobi-timezone business (no instant shift applied)", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(11);
      const effectiveFrom = new Date(Date.UTC(period.year, period.month - 1, 1)).toISOString().slice(0, 10);
      await setPercentageCompensation(employee.id, 15, effectiveFrom);

      const { start } = getBusinessMonthBounds("Africa/Nairobi", period.year, period.month);
      const sale = await createBackdatedSale(1, new Date(start.getTime() + 1000), { salespersonEmployeeId: employee.id }); // total = 100
      void sale;

      // Scoped to this test's own employee -- generatePayrollForBusiness
      // generates for every active employee in the (shared, cross-test)
      // business, and earlier tests in this file left employees with
      // PERCENTAGE compensation effective from 2020-01-01, which also
      // covers this period. Asserting array length here would be a false
      // dependency on test-execution order, the same class of mistake
      // already documented and fixed once before in this repo's history
      // (Module 12 Session A's own Bulk Pay test-isolation fix).
      const result = await generatePayrollForBusiness(businessId, period.year, period.month);
      const generatedForThisEmployee = result.generated.find((g) => g.employeeId === employee.id);
      expect(generatedForThisEmployee).toBeTruthy();
      const record = await prisma.payroll_records.findUniqueOrThrow({ where: { id: generatedForThisEmployee!.payrollRecordId } });
      expect(record.compensation_model).toBe("PERCENTAGE");
      expect(record.amount.toString()).toBe("15"); // 15% of 100
    });
  });
});
