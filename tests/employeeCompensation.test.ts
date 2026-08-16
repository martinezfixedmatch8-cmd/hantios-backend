import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner } from "./helpers/factories";
import { generatePayrollForBusiness } from "../src/services/payroll.service";

const idemKey = () => `test-${randomUUID()}`;

describe("HNT-PAY-002: Compensation effective-date rows cannot overlap under concurrent writes", () => {
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

  async function createEmployee(name = `Comp Test Employee ${randomUUID()}`) {
    const res = await request(app)
      .post("/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ name, phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}` });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  function setComp(employeeId: string, effectiveFrom: string, monthlySalary: number) {
    return request(app)
      .post(`/employees/${employeeId}/compensation`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ compensationModel: "FIXED_MONTHLY", effectiveFrom, config: { monthlySalary } });
  }

  it("under genuine concurrency, two simultaneous compensation-creation requests for the SAME employee never both end up as the current row", async () => {
    const employee = await createEmployee();

    const [first, second] = await Promise.all([setComp(employee.id, "2020-01-01", 100), setComp(employee.id, "2020-01-01", 200)]);

    // Both requests race for the SAME effectiveFrom against a brand-new
    // employee with no prior compensation at all. The lock serializes them:
    // whichever acquires it first creates the row (201); the second then
    // re-reads under the lock, sees that row as "current" with the exact
    // same effectiveFrom, and correctly hits the pre-existing "effectiveFrom
    // must be after the current row's own effective_from" business
    // rejection (400) -- not a lock/index violation, a legitimate business
    // rule, now finally reachable for real instead of racing. The real,
    // authoritative proof is the DB state, not which HTTP code landed where:
    // at most one row is ever left with effective_to IS NULL.
    const statuses = [first.status, second.status];
    expect(statuses).toContain(201); // exactly one succeeds
    expect(statuses).toContain(400); // the other is correctly rejected, not silently duplicated

    const openRows = await prisma.employee_compensation.findMany({
      where: { business_id: businessId, employee_id: employee.id, effective_to: null },
    });
    expect(openRows).toHaveLength(1); // never two simultaneously-open rows
  });

  it("adjacent, non-overlapping periods succeed -- the earlier row's effective_to closes exactly at the later row's effective_from", async () => {
    const employee = await createEmployee();
    const first = await setComp(employee.id, "2020-01-01", 100);
    expect(first.status).toBe(201);

    const second = await setComp(employee.id, "2020-06-01", 200);
    expect(second.status).toBe(201);

    const rows = await prisma.employee_compensation.findMany({
      where: { business_id: businessId, employee_id: employee.id },
      orderBy: { effective_from: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].effective_to?.toISOString().slice(0, 10)).toBe("2020-06-01");
    expect(rows[1].effective_to).toBeNull();
  });

  it("rejects an effectiveFrom that would overlap with the currently-open row (at or before its own effective_from)", async () => {
    const employee = await createEmployee();
    const first = await setComp(employee.id, "2020-06-01", 100);
    expect(first.status).toBe(201);

    const overlapping = await setComp(employee.id, "2020-01-01", 200); // BEFORE the current row's own start
    expect(overlapping.status).toBe(400);

    const sameDay = await setComp(employee.id, "2020-06-01", 300); // exactly equal
    expect(sameDay.status).toBe(400);

    const rows = await prisma.employee_compensation.findMany({ where: { business_id: businessId, employee_id: employee.id } });
    expect(rows).toHaveLength(1); // the rejected attempts never created anything
  });

  it("the real DB-level guarantee: a direct duplicate-open-row insert attempt is rejected by the partial unique index itself, not just app logic", async () => {
    const employee = await createEmployee();
    const first = await setComp(employee.id, "2020-01-01", 100);
    expect(first.status).toBe(201);

    // Bypass the service entirely -- prove the index itself, not just the
    // application-layer lock, is what makes this impossible.
    await expect(
      prisma.employee_compensation.create({
        data: {
          id: `dup-comp-${randomUUID()}`,
          business_id: businessId,
          employee_id: employee.id,
          compensation_model: "FIXED_MONTHLY",
          effective_from: new Date("2021-01-01"),
          effective_to: null,
          currency_code: "KES",
          compensation_config: { monthlySalary: "999" },
          created_by: (await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } })).owner_id!,
        },
      })
    ).rejects.toThrow();
  });

  it("payroll generation at a period boundary correctly uses the compensation structure effective for that exact period, never the one before or after", async () => {
    const employee = await createEmployee();
    // Two structures: 100/mo from 2019-01-01, 300/mo from 2019-03-01.
    await setComp(employee.id, "2019-01-01", 100);
    const second = await setComp(employee.id, "2019-03-01", 300);
    expect(second.status).toBe(201);

    await generatePayrollForBusiness(businessId, 2019, 2); // February -- still under the FIRST structure
    await generatePayrollForBusiness(businessId, 2019, 3); // March -- the boundary month, the SECOND structure

    const feb = await prisma.payroll_records.findFirstOrThrow({
      where: { business_id: businessId, employee_id: employee.id, period_year: 2019, period_month: 2 },
    });
    const mar = await prisma.payroll_records.findFirstOrThrow({
      where: { business_id: businessId, employee_id: employee.id, period_year: 2019, period_month: 3 },
    });
    expect(feb.amount.toString()).toBe("100");
    expect(mar.amount.toString()).toBe("300");
  });
});
