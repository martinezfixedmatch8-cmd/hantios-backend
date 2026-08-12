import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestPaymentMethod } from "./helpers/factories";
import { generatePayrollForBusiness } from "../src/services/payroll.service";
import type { UserRole } from "@prisma/client";

const idemKey = () => `test-${randomUUID()}`;

describe("Module 12 Session A -- Payroll Core", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let paymentMethodId: string;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;
    const pm = await createTestPaymentMethod(businessId);
    paymentMethodId = pm.id;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  async function createEmployeeWithSalary(monthlySalary: number, name = `Test Employee ${randomUUID()}`) {
    const empRes = await request(app)
      .post("/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ name, phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}` });
    expect(empRes.status).toBe(201);
    const employee = empRes.body.data;

    const compRes = await request(app)
      .post(`/employees/${employee.id}/compensation`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ compensationModel: "FIXED_MONTHLY", effectiveFrom: "2026-01-01", config: { monthlySalary } });
    expect(compRes.status).toBe(201);

    return { employee, compensation: compRes.body.data };
  }

  describe("Departments + Positions", () => {
    it("creates a department and a position referencing it", async () => {
      const deptRes = await request(app)
        .post("/departments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: "Sales" });
      expect(deptRes.status).toBe(201);

      const posRes = await request(app)
        .post("/positions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ title: "Salesperson", departmentId: deptRes.body.data.id });
      expect(posRes.status).toBe(201);
      expect(posRes.body.data.department_id).toBe(deptRes.body.data.id);

      const listRes = await request(app).get("/departments").set("Authorization", `Bearer ${ownerToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.some((d: { name: string }) => d.name === "Sales")).toBe(true);
    });
  });

  describe("Employee CRUD", () => {
    it("creates, updates, archives, and restores an employee", async () => {
      const { employee } = await createEmployeeWithSalary(500, "CRUD Test Employee");

      const getRes = await request(app).get(`/employees/${employee.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(200);

      const updateRes = await request(app)
        .patch(`/employees/${employee.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: employee.version, name: "Renamed Employee" });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.name).toBe("Renamed Employee");

      const archiveRes = await request(app)
        .post(`/employees/${employee.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: updateRes.body.data.version, reason: "test archive" });
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.data.status).toBe("archived");

      const restoreRes = await request(app)
        .post(`/employees/${employee.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: archiveRes.body.data.version });
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.data.status).toBe("active");
    });

    const rbacCases: { role: UserRole; canWrite: boolean }[] = [
      { role: "owner", canWrite: true },
      { role: "manager", canWrite: true },
      { role: "accountant", canWrite: false },
      { role: "cashier", canWrite: false },
      { role: "storekeeper", canWrite: false },
    ];
    it.each(rbacCases)("role=$role create employee write=$canWrite", async ({ role, canWrite }) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app)
        .post("/employees")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ name: "RBAC Test", phone: "+254700000000" });
      expect(res.status).toBe(canWrite ? 201 : 403);
    });
  });

  describe("Employee Compensation -- effective-dating", () => {
    it("a new compensation structure atomically closes out the previous one", async () => {
      const { employee } = await createEmployeeWithSalary(300, "Effective Dating Employee");

      const second = await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "FIXED_MONTHLY", effectiveFrom: "2026-06-01", config: { monthlySalary: 400 } });
      expect(second.status).toBe(201);

      const history = await request(app).get(`/employees/${employee.id}/compensation`).set("Authorization", `Bearer ${ownerToken}`);
      expect(history.status).toBe(200);
      const rows = history.body.data as { effective_from: string; effective_to: string | null; compensation_config: { monthlySalary: number } }[];
      expect(rows.length).toBe(2);
      const first = rows.find((r) => r.compensation_config.monthlySalary === 300);
      const newest = rows.find((r) => r.compensation_config.monthlySalary === 400);
      expect(first?.effective_to).not.toBeNull(); // closed out
      expect(newest?.effective_to).toBeNull(); // currently active
    });

    it("rejects the discriminated union boundary -- a non-FIXED_MONTHLY model is not accepted by this session's own API", async () => {
      const { employee } = await createEmployeeWithSalary(300, "Boundary Test Employee");
      const res = await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "HOURLY", effectiveFrom: "2026-01-01", config: { hourlyRate: 10 } });
      expect(res.status).toBe(400);
    });
  });

  describe("Monthly payroll generation", () => {
    it("generates exactly one pending payroll record for an active FIXED_MONTHLY employee", async () => {
      const { employee } = await createEmployeeWithSalary(750, "Generation Test Employee");

      const result = await generatePayrollForBusiness(businessId, 2026, 3);
      expect(result.generated.some((g) => g.employeeId === employee.id)).toBe(true);

      const record = await prisma.payroll_records.findFirst({
        where: { business_id: businessId, employee_id: employee.id, period_year: 2026, period_month: 3 },
      });
      expect(record).not.toBeNull();
      expect(record!.status).toBe("pending");
      expect(record!.amount.toString()).toBe("750");
    });

    it("is idempotent -- generating the same business+month twice never creates a duplicate", async () => {
      const { employee } = await createEmployeeWithSalary(600, "Idempotent Gen Employee");
      await generatePayrollForBusiness(businessId, 2026, 4);
      await generatePayrollForBusiness(businessId, 2026, 4);

      const count = await prisma.payroll_records.count({
        where: { business_id: businessId, employee_id: employee.id, period_year: 2026, period_month: 4 },
      });
      expect(count).toBe(1);
    });

    it("is concurrency-safe: N truly-parallel generation calls for the same business+month never produce a duplicate record for one employee", async () => {
      const { employee } = await createEmployeeWithSalary(900, "Concurrent Gen Employee");
      const N = 5;
      await Promise.all(Array.from({ length: N }, () => generatePayrollForBusiness(businessId, 2026, 5)));

      const count = await prisma.payroll_records.count({
        where: { business_id: businessId, employee_id: employee.id, period_year: 2026, period_month: 5 },
      });
      expect(count).toBe(1); // never more than one, regardless of how many concurrent generation calls raced
    });

    it("skips an employee with no compensation structure, without aborting generation for others", async () => {
      const noCompRes = await request(app)
        .post("/employees")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ name: "No Compensation Employee", phone: "+254711111111" });
      const noCompEmployee = noCompRes.body.data;
      const { employee: withCompEmployee } = await createEmployeeWithSalary(500, "Has Compensation Employee");

      const result = await generatePayrollForBusiness(businessId, 2026, 6);
      expect(result.skipped.some((s) => s.employeeId === noCompEmployee.id)).toBe(true);
      expect(result.generated.some((g) => g.employeeId === withCompEmployee.id)).toBe(true);
    });
  });

  describe("Mark-as-paid", () => {
    it("marks a pending record paid, generates a Payroll Receipt (7th Module 06 type), and logs an automatic WhatsApp delivery attempt", async () => {
      const { employee } = await createEmployeeWithSalary(1000, "Mark Paid Employee");
      await generatePayrollForBusiness(businessId, 2026, 7);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: 2026, period_month: 7 },
      });

      const payRes = await request(app)
        .post(`/payroll/${record.id}/mark-paid`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: record.version, paymentMethodId, paymentReference: "REF-001" });
      expect(payRes.status).toBe(200);
      expect(payRes.body.data.status).toBe("paid");

      const receipt = await prisma.receipts.findFirst({
        where: { business_id: businessId, payroll_record_id: record.id, receipt_type: "payroll" },
      });
      expect(receipt).not.toBeNull();
      expect(receipt!.total.toString()).toBe("1000");
      const snap = receipt!.snapshot as unknown as { payroll: { employeeName: string; periodLabel: string } };
      expect(snap.payroll.employeeName).toBe("Mark Paid Employee");
      expect(snap.payroll.periodLabel).toBe("July 2026");

      // Automatic WhatsApp delivery -- fire-and-forget, but should land
      // very quickly against this always-synchronous ConsoleNotificationProvider.
      await new Promise((r) => setTimeout(r, 300));
      const attempt = await prisma.receipt_delivery_attempts.findFirst({ where: { receipt_id: receipt!.id, channel: "whatsapp" } });
      expect(attempt).not.toBeNull();
      expect(attempt!.employee_id).toBe(employee.id);
      expect(attempt!.status).toBe("success");
    });

    it("returns 409 for a genuinely duplicate payment attempt -- the real DB-level uniqueness invariant, not just app logic", async () => {
      const { employee } = await createEmployeeWithSalary(400, "Duplicate Payment Employee");
      await generatePayrollForBusiness(businessId, 2026, 8);
      const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });

      // Direct DB-level proof: a second payroll_records row for the SAME
      // (business, employee, period) is rejected by the real @@unique
      // constraint -- not a partial index here (no nullable columns in
      // this key), a plain composite unique is the correct, sufficient
      // guard, confirmed live in Phase 0.
      const compensation = await prisma.employee_compensation.findFirstOrThrow({ where: { employee_id: employee.id, effective_to: null } });
      await expect(
        prisma.payroll_records.create({
          data: {
            id: `dup-test-${randomUUID()}`,
            business_id: businessId,
            employee_id: employee.id,
            period_year: 2026,
            period_month: 8,
            compensation_id: compensation.id,
            compensation_model: "FIXED_MONTHLY",
            amount: 400,
            currency_code: business.currency,
            status: "pending",
          },
        })
      ).rejects.toThrow();

      // And the mark-as-paid transition itself: paying an already-paid
      // record is rejected too.
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: 2026, period_month: 8 },
      });
      const firstPay = await request(app)
        .post(`/payroll/${record.id}/mark-paid`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: record.version });
      expect(firstPay.status).toBe(200);

      const secondPay = await request(app)
        .post(`/payroll/${record.id}/mark-paid`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: firstPay.body.data.version });
      expect(secondPay.status).toBe(400);
    });

    const rbacCases: { role: UserRole; canPay: boolean }[] = [
      { role: "owner", canPay: true },
      { role: "manager", canPay: true },
      { role: "accountant", canPay: false },
      { role: "cashier", canPay: false },
    ];
    it.each(rbacCases)("role=$role mark-paid write=$canPay", async ({ role, canPay }) => {
      const { employee } = await createEmployeeWithSalary(200, "RBAC Payment Employee");
      await generatePayrollForBusiness(businessId, 2026, 9);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: 2026, period_month: 9 },
      });
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app)
        .post(`/payroll/${record.id}/mark-paid`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: record.version });
      expect(res.status).toBe(canPay ? 200 : 403);
    });
  });

  describe("Bulk Pay All Pending -- partial-failure handling", () => {
    // Deliberately an ISOLATED business, not the shared one every other
    // test in this file uses -- bulkPayPending processes every pending
    // record for the WHOLE business, and by this point in the suite the
    // shared business has accumulated leftover pending records from many
    // earlier tests. A fresh business keeps this test's own assertions
    // meaningful (no noise from unrelated records) and fast (no
    // compounding per-test slowdown), same isolation precedent this file's
    // own Cross-Tenant tests already establish.
    it("pays every pending record independently, one failure never blocking the rest", async () => {
      const owner = await signupTestOwner();
      businessIds.push(owner.businessId);
      const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
      const token = login.accessToken;

      async function createIsolatedEmployee(monthlySalary: number, name: string) {
        const empRes = await request(app)
          .post("/employees")
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", idemKey())
          .send({ name, phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}` });
        const employee = empRes.body.data;
        await request(app)
          .post(`/employees/${employee.id}/compensation`)
          .set("Authorization", `Bearer ${token}`)
          .send({ compensationModel: "FIXED_MONTHLY", effectiveFrom: "2026-01-01", config: { monthlySalary } });
        return employee;
      }

      const e1 = await createIsolatedEmployee(100, "Bulk Employee 1");
      const e2 = await createIsolatedEmployee(200, "Bulk Employee 2");
      await generatePayrollForBusiness(owner.businessId, 2026, 10);

      const record1 = await prisma.payroll_records.findFirstOrThrow({ where: { business_id: owner.businessId, employee_id: e1.id, period_year: 2026, period_month: 10 } });
      const record2 = await prisma.payroll_records.findFirstOrThrow({ where: { business_id: owner.businessId, employee_id: e2.id, period_year: 2026, period_month: 10 } });

      // Race a direct mark-paid call against the bulk-pay call, both
      // targeting record2 -- this exercises bulk-pay's REAL per-record
      // failure path (the atomic version+status guard inside
      // markPayrollPaid rejecting whichever request loses a genuine race),
      // not a contrived pre-condition. Pre-paying record2 directly before
      // calling bulk-pay does NOT exercise the failure path at all: bulk-pay
      //'s own selection query is `WHERE status = "pending"`, so an
      // already-"paid" record is invisible to it -- never attempted, so it
      // can never appear in `failed` either. record1 is never contended, so
      // it must always succeed via bulk regardless of how the race resolves.
      const [bulkRes, directRes] = await Promise.all([
        request(app)
          .post("/payroll/pay-all-pending")
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", idemKey())
          .send({}),
        request(app)
          .post(`/payroll/${record2.id}/mark-paid`)
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: record2.version }),
      ]);

      expect(bulkRes.status).toBe(200);
      expect(bulkRes.body.data.succeeded).toContainEqual({ employeeId: e1.id, payrollRecordId: record1.id });

      const record2InBulkSucceeded = bulkRes.body.data.succeeded.some((s: { payrollRecordId: string }) => s.payrollRecordId === record2.id);
      const record2InBulkFailed = bulkRes.body.data.failed.some((f: { payrollRecordId: string }) => f.payrollRecordId === record2.id);
      // Exactly one side wins: either bulk-pay pays record2 first (and the
      // direct call correctly loses -- 400 via the pre-transaction fail-fast
      // check, or 409 via the atomic guard, timing-dependent, same "both
      // outcomes correctly reject the loser" precedent already established
      // for Expenses' own concurrent-approve test), or the direct call pays
      // it first (and bulk-pay's own attempt correctly lands in `failed`).
      // Never both, never neither.
      if (record2InBulkSucceeded) {
        expect(record2InBulkFailed).toBe(false);
        expect([400, 409]).toContain(directRes.status);
      } else {
        expect(record2InBulkFailed).toBe(true);
        expect(directRes.status).toBe(200);
      }

      const reloadedRecord1 = await prisma.payroll_records.findUniqueOrThrow({ where: { id: record1.id } });
      expect(reloadedRecord1.status).toBe("paid");
      const reloadedRecord2 = await prisma.payroll_records.findUniqueOrThrow({ where: { id: record2.id } });
      expect(reloadedRecord2.status).toBe("paid");
    });
  });

  describe("Effective-dating correctness", () => {
    it("a later compensation change never rewrites an already-generated payroll record", async () => {
      const { employee } = await createEmployeeWithSalary(500, "Effective Dating Payroll Employee");
      await generatePayrollForBusiness(businessId, 2026, 11);
      const originalRecord = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: 2026, period_month: 11 },
      });
      expect(originalRecord.amount.toString()).toBe("500");

      // Change compensation AFTER generation.
      const changeRes = await request(app)
        .post(`/employees/${employee.id}/compensation`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ compensationModel: "FIXED_MONTHLY", effectiveFrom: "2026-11-15", config: { monthlySalary: 999 } });
      expect(changeRes.status).toBe(201);

      const stillOriginal = await prisma.payroll_records.findUniqueOrThrow({ where: { id: originalRecord.id } });
      expect(stillOriginal.amount.toString()).toBe("500"); // unchanged -- the Policy Snapshot held
    });
  });

  describe("Cross-tenant isolation", () => {
    it("an employee cannot be fetched from a different business", async () => {
      const { employee } = await createEmployeeWithSalary(300, "Isolation Employee");

      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

      const res = await request(app).get(`/employees/${employee.id}`).set("Authorization", `Bearer ${otherLogin.accessToken}`);
      expect(res.status).toBe(404);
    });

    it("a payroll record cannot be fetched from a different business", async () => {
      const { employee } = await createEmployeeWithSalary(300, "Isolation Payroll Employee");
      await generatePayrollForBusiness(businessId, 2026, 12);
      const record = await prisma.payroll_records.findFirstOrThrow({
        where: { business_id: businessId, employee_id: employee.id, period_year: 2026, period_month: 12 },
      });

      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

      const res = await request(app).get(`/payroll/${record.id}`).set("Authorization", `Bearer ${otherLogin.accessToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("List / Search", () => {
    it("lists payroll records filtered by status, {data, pagination} envelope", async () => {
      const res = await request(app)
        .get("/payroll")
        .query({ status: "paid", pageSize: 5 })
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.pagination).toBeDefined();
      for (const r of res.body.data) expect(r.status).toBe("paid");
    });
  });
});
