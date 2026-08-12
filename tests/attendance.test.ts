import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken } from "./helpers/factories";
import { generatePayrollForBusiness } from "../src/services/payroll.service";
import { getApprovedHoursForPeriod } from "../src/services/attendance.service";
import { getBusinessDay } from "../src/lib/businessTime";
import type { UserRole } from "@prisma/client";

const idemKey = () => `test-${randomUUID()}`;

function addDaysToDateString(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Attendance's own workDate is rejected once it's later than the business's
// real current business day (confirmed Q3), so every test needing an
// "any valid past date within a period" fixture computes it relative to
// real wall-clock "now" -- never a hardcoded future-looking literal like
// "2026-09-05" -- to stay correct regardless of when the suite actually
// runs. `monthsAgo(n)` for n>=1 is always entirely in the past, with a
// full calendar month of safety margin, avoiding any month-boundary edge
// case near the start/end of "today"'s own month.
function monthsAgo(n: number): { year: number; month: number } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
function dateInPeriod(period: { year: number; month: number }, day: number): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

describe("Module 12 Session B -- Attendance & Time Tracking", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerId: string;
  let ownerToken: string;
  let todayBusinessDay: string;
  const safePeriod = monthsAgo(2);

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    ownerId = owner.ownerId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;

    const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
    // Computed via the SAME mechanism the server itself uses, not
    // independent naive UTC arithmetic -- avoids the exact wall-clock-
    // dependent flakiness class already documented elsewhere in this repo
    // (debt.test.ts's own UTC-vs-business-timezone test flake).
    todayBusinessDay = getBusinessDay(business.timezone, business.business_day_start_time, new Date());
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  async function createEmployee(name = `Attendance Employee ${randomUUID()}`, token = ownerToken) {
    const res = await request(app)
      .post("/employees")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ name, phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}` });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function setHourlyCompensation(employeeId: string, hourlyRate: number, token = ownerToken) {
    const res = await request(app)
      .post(`/employees/${employeeId}/compensation`)
      .set("Authorization", `Bearer ${token}`)
      .send({ compensationModel: "HOURLY", effectiveFrom: "2020-01-01", config: { hourlyRate } });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  describe("Recording attendance", () => {
    it("records attendance directly as approved, with recorded_by/approved_by/approved_at explicitly set", async () => {
      const employee = await createEmployee();
      const res = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: todayBusinessDay, hoursWorked: 8 });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("approved");
      expect(res.body.data.recorded_by).toBe(ownerId);
      expect(res.body.data.approved_by).toBe(ownerId);
      expect(res.body.data.approved_at).not.toBeNull();
      expect(res.body.data.hours_worked).toBe("8");
    });

    it("returns a real DB-level 409 for a duplicate employee+work_date entry", async () => {
      const employee = await createEmployee();
      const first = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: todayBusinessDay, hoursWorked: 8 });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: todayBusinessDay, hoursWorked: 5 });
      expect(second.status).toBe(409);
    });

    it("accepts an explicit back-dated workDate", async () => {
      const employee = await createEmployee();
      const yesterday = addDaysToDateString(todayBusinessDay, -1);
      const res = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: yesterday, hoursWorked: 6 });
      expect(res.status).toBe(201);
    });

    it("rejects a workDate later than the business's own current business day", async () => {
      const employee = await createEmployee();
      const tomorrow = addDaysToDateString(todayBusinessDay, 1);
      const res = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: tomorrow, hoursWorked: 6 });
      expect(res.status).toBe(400);
    });

    it("allows recording a legitimate zero-hours (absence) entry", async () => {
      const employee = await createEmployee();
      const res = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: todayBusinessDay, hoursWorked: 0 });
      expect(res.status).toBe(201);
      expect(res.body.data.hours_worked).toBe("0");
    });

    it("rejects an employeeId belonging to a different business", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);
      const otherEmployee = await createEmployee(`Other Business Employee ${randomUUID()}`, otherLogin.accessToken);

      const res = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: otherEmployee.id, workDate: todayBusinessDay, hoursWorked: 4 });
      expect(res.status).toBe(404);
    });

    const rbacCases: { role: UserRole; canWrite: boolean; canView: boolean }[] = [
      { role: "owner", canWrite: true, canView: true },
      { role: "manager", canWrite: true, canView: true },
      { role: "accountant", canWrite: false, canView: true },
      { role: "cashier", canWrite: false, canView: false },
      { role: "storekeeper", canWrite: false, canView: false },
    ];
    it.each(rbacCases)("role=$role record write=$canWrite, list view=$canView", async ({ role, canWrite, canView }) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const writeRes = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: (await createEmployee()).id, workDate: todayBusinessDay, hoursWorked: 3 });
      expect(writeRes.status).toBe(canWrite ? 201 : 403);

      const viewRes = await request(app).get("/attendance").set("Authorization", `Bearer ${token}`);
      expect(viewRes.status).toBe(canView ? 200 : 403);
    });
  });

  describe("Bulk record -- partial-failure handling", () => {
    it("records every entry independently, one duplicate never blocking a genuinely new entry", async () => {
      const employee1 = await createEmployee();
      const employee2 = await createEmployee();
      const workDate = addDaysToDateString(todayBusinessDay, -2);

      // Pre-existing record for employee1 on this exact date -- the bulk
      // call's own attempt at the SAME employee+date must fail, without
      // blocking employee2's genuinely new entry.
      const pre = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee1.id, workDate, hoursWorked: 8 });
      expect(pre.status).toBe(201);

      const bulkRes = await request(app)
        .post("/attendance/bulk")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({
          entries: [
            { employeeId: employee1.id, workDate, hoursWorked: 5 },
            { employeeId: employee2.id, workDate, hoursWorked: 7 },
          ],
        });

      expect(bulkRes.status).toBe(200);
      expect(bulkRes.body.data.succeeded).toEqual([{ employeeId: employee2.id, attendanceRecordId: expect.any(String) }]);
      expect(bulkRes.body.data.failed).toHaveLength(1);
      expect(bulkRes.body.data.failed[0].employeeId).toBe(employee1.id);
    });

    const bulkRbacCases: { role: UserRole; canWrite: boolean }[] = [
      { role: "owner", canWrite: true },
      { role: "manager", canWrite: true },
      { role: "accountant", canWrite: false },
    ];
    it.each(bulkRbacCases)("role=$role bulk record write=$canWrite", async ({ role, canWrite }) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const employee = await createEmployee();
      const res = await request(app)
        .post("/attendance/bulk")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ entries: [{ employeeId: employee.id, workDate: todayBusinessDay, hoursWorked: 4 }] });
      expect(res.status).toBe(canWrite ? 200 : 403);
    });
  });

  describe("Approved Hours aggregation", () => {
    it("aggregates approved hours across multiple days within a period, excluding days outside it", async () => {
      const employee = await createEmployee();
      const outsideBefore = monthsAgo(4);
      const outsideAfter = monthsAgo(1);
      // Inside the safe period.
      await request(app).post("/attendance").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(safePeriod, 1), hoursWorked: 8 });
      await request(app).post("/attendance").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(safePeriod, 15), hoursWorked: 6 });
      // Outside the period -- must be excluded.
      await request(app).post("/attendance").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(outsideBefore, 28), hoursWorked: 100 });
      await request(app).post("/attendance").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(outsideAfter, 1), hoursWorked: 100 });

      const total = await getApprovedHoursForPeriod(businessId, employee.id, safePeriod.year, safePeriod.month);
      expect(total.toString()).toBe("14");
    });

    it("incorporates adjustment deltas without mutating the original attendance record", async () => {
      const employee = await createEmployee();
      const recordRes = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(safePeriod, 10), hoursWorked: 8 });
      expect(recordRes.status).toBe(201);

      const adjRes = await request(app)
        .post(`/attendance/${recordRes.body.data.id}/adjustments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaHours: -1, reason: "corrected after review" });
      expect(adjRes.status).toBe(201);

      const total = await getApprovedHoursForPeriod(businessId, employee.id, safePeriod.year, safePeriod.month);
      expect(total.toString()).toBe("7");

      const reloaded = await prisma.attendance_records.findUniqueOrThrow({ where: { id: recordRes.body.data.id } });
      expect(reloaded.hours_worked.toString()).toBe("8"); // original untouched
    });
  });

  describe("Adjustments", () => {
    it("bundles adjustments onto GET /attendance/:id", async () => {
      const employee = await createEmployee();
      const recordRes = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(safePeriod, 11), hoursWorked: 8 });

      await request(app)
        .post(`/attendance/${recordRes.body.data.id}/adjustments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaHours: -2, reason: "corrected after review" });

      const getRes = await request(app).get(`/attendance/${recordRes.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.attendance_adjustments).toHaveLength(1);
      expect(getRes.body.data.attendance_adjustments[0].delta_hours).toBe("-2");
    });

    it("rejects an adjustment that would push effective hours negative", async () => {
      const employee = await createEmployee();
      const recordRes = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(safePeriod, 12), hoursWorked: 2 });

      const res = await request(app)
        .post(`/attendance/${recordRes.body.data.id}/adjustments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaHours: -5, reason: "would go negative" });
      expect(res.status).toBe(400);
    });

    it("rejects an adjustment against a not-yet-approved record", async () => {
      const employee = await createEmployee();
      const recordRes = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(safePeriod, 13), hoursWorked: 8 });

      // No self-service flow exists yet to reach status="recorded" through
      // the API this session -- directly simulating the future state to
      // prove the guard holds regardless.
      await prisma.attendance_records.update({ where: { id: recordRes.body.data.id }, data: { status: "recorded", approved_by: null, approved_at: null } });

      const res = await request(app)
        .post(`/attendance/${recordRes.body.data.id}/adjustments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaHours: -1, reason: "should be rejected" });
      expect(res.status).toBe(400);
    });

    it("requires a non-empty reason", async () => {
      const employee = await createEmployee();
      const recordRes = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(safePeriod, 14), hoursWorked: 8 });

      const res = await request(app)
        .post(`/attendance/${recordRes.body.data.id}/adjustments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaHours: -1, reason: "" });
      expect(res.status).toBe(400);
    });

    const adjustmentRbacCases: { role: UserRole; canWrite: boolean; day: number }[] = [
      { role: "owner", canWrite: true, day: 20 },
      { role: "manager", canWrite: true, day: 21 },
      { role: "accountant", canWrite: false, day: 22 },
    ];
    it.each(adjustmentRbacCases)("role=$role adjustment write=$canWrite", async ({ role, canWrite, day }) => {
      const employee = await createEmployee();
      const recordRes = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(safePeriod, day), hoursWorked: 8 });

      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app)
        .post(`/attendance/${recordRes.body.data.id}/adjustments`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaHours: -1, reason: "RBAC test" });
      expect(res.status).toBe(canWrite ? 201 : 403);
    });
  });

  describe("HOURLY payroll generation", () => {
    it("calculates gross pay from Approved Hours x rate, with correct snapshot columns", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(5);
      await setHourlyCompensation(employee.id, 5);
      await request(app).post("/attendance").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(period, 5), hoursWorked: 8 });
      await request(app).post("/attendance").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(period, 6), hoursWorked: 8 });
      await request(app).post("/attendance").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(period, 7), hoursWorked: 4 });
      // 20 hours total x $5 = $100

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.compensation_model).toBe("HOURLY");
      expect(record.amount.toString()).toBe("100");
      expect(record.hours_calculated?.toString()).toBe("20");
      expect(record.hourly_rate?.toString()).toBe("5");
    });

    it("a post-generation attendance change does not rewrite an already-generated payroll record", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(6);
      await setHourlyCompensation(employee.id, 10);
      await request(app).post("/attendance").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(period, 8), hoursWorked: 5 });

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const original = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(original.amount.toString()).toBe("50");

      // Record MORE attendance for the same period, after generation.
      await request(app).post("/attendance").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: dateInPeriod(period, 9), hoursWorked: 8 });

      const stillOriginal = await prisma.payroll_records.findUniqueOrThrow({ where: { id: original.id } });
      expect(stillOriginal.amount.toString()).toBe("50"); // unchanged -- the Calculation Snapshot held
      expect(stillOriginal.hours_calculated?.toString()).toBe("5");
    });

    it("zero approved hours produces a legitimate $0.00 record, never a skip", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(7);
      await setHourlyCompensation(employee.id, 7);
      // No attendance recorded at all for this period.

      const result = await generatePayrollForBusiness(businessId, period.year, period.month);
      expect(result.skipped.some((s) => s.employeeId === employee.id)).toBe(false);
      expect(result.generated.some((g) => g.employeeId === employee.id)).toBe(true);

      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.amount.toString()).toBe("0");
      expect(record.hours_calculated?.toString()).toBe("0");
    });

    it("FIXED_MONTHLY payroll records remain unaffected -- hours_calculated/hourly_rate stay null", async () => {
      const employee = await createEmployee();
      const period = monthsAgo(8);
      await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "FIXED_MONTHLY", effectiveFrom: "2020-01-01", config: { monthlySalary: 300 } });

      await generatePayrollForBusiness(businessId, period.year, period.month);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: period.year, period_month: period.month },
      });
      expect(record.compensation_model).toBe("FIXED_MONTHLY");
      // Matches this repo's own established Prisma.Decimal precedent
      // (tests/payroll.test.ts's own equivalent assertion): a value
      // constructed via `new Prisma.Decimal(300)` from a plain JS number
      // has no forced trailing zeros -- the DB column's own DECIMAL(14,2)
      // scale doesn't retroactively reformat the value's own toString().
      expect(record.amount.toString()).toBe("300");
      expect(record.hours_calculated).toBeNull();
      expect(record.hourly_rate).toBeNull();
    });
  });

  describe("compensation_config Zod boundary -- HOURLY writable, others still rejected", () => {
    it("accepts HOURLY with a valid Decimal hourlyRate", async () => {
      const employee = await createEmployee();
      const res = await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "HOURLY", effectiveFrom: "2020-01-01", config: { hourlyRate: "3.50" } });
      expect(res.status).toBe(201);
    });

    it("rejects HOURLY with more than 2 decimal places", async () => {
      const employee = await createEmployee();
      const res = await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "HOURLY", effectiveFrom: "2020-01-01", config: { hourlyRate: 3.505 } });
      expect(res.status).toBe(400);
    });

    const stillRejectedModels = ["PERCENTAGE", "FIXED_PLUS_PERCENTAGE", "FIXED_PLUS_TIME", "PIECE_RATE", "CONTRACT", "CUSTOM"];
    it.each(stillRejectedModels)("still rejects %s -- structurally unwritable through this endpoint", async (model) => {
      const employee = await createEmployee();
      const res = await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: model, effectiveFrom: "2020-01-01", config: { rate: 5 } });
      expect(res.status).toBe(400);
    });
  });

  describe("Business-timezone date-boundary correctness", () => {
    it("accepts workDate exactly at the business's own current business day, computed via the real mechanism", async () => {
      const employee = await createEmployee();
      const res = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: employee.id, workDate: todayBusinessDay, hoursWorked: 1 });
      expect(res.status).toBe(201);
    });

    it("demonstrates the UTC-midnight-crossing example against the business's real timezone (Africa/Nairobi, UTC+3)", async () => {
      const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
      expect(business.timezone).toBe("Africa/Nairobi");
      // Same shape as the locked example (Mogadishu, also UTC+3): a UTC
      // timestamp of 21:30 the day before lands on the NEXT calendar day
      // once bucketed into the business's own local timezone.
      const utcTimestamp = new Date("2026-08-11T21:30:00.000Z");
      const businessDay = getBusinessDay(business.timezone, business.business_day_start_time, utcTimestamp);
      expect(businessDay).toBe("2026-08-12");
    });
  });

  describe("Cross-tenant isolation", () => {
    it("cannot fetch or adjust an attendance record from a different business", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);
      const otherEmployee = await createEmployee(`Cross Tenant Employee ${randomUUID()}`, otherLogin.accessToken);
      const otherRecord = await request(app)
        .post("/attendance")
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ employeeId: otherEmployee.id, workDate: todayBusinessDay, hoursWorked: 4 });
      expect(otherRecord.status).toBe(201);

      const getRes = await request(app).get(`/attendance/${otherRecord.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(404);

      const adjRes = await request(app)
        .post(`/attendance/${otherRecord.body.data.id}/adjustments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ deltaHours: -1, reason: "cross-tenant attempt" });
      expect(adjRes.status).toBe(404);
    });
  });
});
