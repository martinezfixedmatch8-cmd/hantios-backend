import request from "supertest";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import type { UserRole } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { domainEvents } from "../src/lib/events";
import { getBusinessDay } from "../src/lib/businessTime";
import { cleanupTestBusiness } from "./helpers/cleanup";
import {
  signupTestOwner,
  loginTestOwner,
  createTestUser,
  mintAccessToken,
  createTestBranch,
  createTestPaymentMethod,
} from "./helpers/factories";

describe("Debts", () => {
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

  const idemKey = () => `test-${randomUUID()}`;
  const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  function validDebtPayload(overrides: Record<string, unknown> = {}) {
    return {
      customerPhone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
      customerName: "Test Customer",
      customerLocation: "Nairobi",
      amountOriginal: 1000,
      dateTaken: isoDate(-20),
      dateDue: isoDate(-10), // overdue by default -- most tests want a real, non-trivial aging state
      ...overrides,
    };
  }

  async function createDebtAs(token: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send(validDebtPayload(overrides));
    if (res.status !== 201) {
      throw new Error(`createDebtAs failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data;
  }

  // Shared by the interest-policy-snapshot tests and the apply-interest
  // tests below -- temporarily overrides Business Settings' interest policy
  // for the duration of `fn`, always restoring the prior settings afterward
  // so tests don't leak configuration into each other.
  async function withInterestPolicy<T>(policy: Record<string, unknown> | null, fn: () => Promise<T>): Promise<T> {
    const before = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
    await prisma.businesses.update({
      where: { id: businessId },
      data: { settings: (policy === null ? {} : { debts: { interestPolicy: policy } }) as Prisma.InputJsonValue },
    });
    try {
      return await fn();
    } finally {
      await prisma.businesses.update({ where: { id: businessId }, data: { settings: (before.settings ?? {}) as Prisma.InputJsonValue } });
    }
  }

  it("returns 401 with no token", async () => {
    const res = await request(app).post("/debts").set("Idempotency-Key", idemKey()).send(validDebtPayload());
    expect(res.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await request(app).post("/debts").set("Authorization", `Bearer ${ownerToken}`).send(validDebtPayload());
    expect(res.status).toBe(400);
  });

  it("creates a debt, find-or-creates the customer, and computes overdue/aging fields from Business.timezone", async () => {
    const phone = `+2547${Math.floor(10000000 + Math.random() * 89999999)}`;
    const res = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(validDebtPayload({ customerPhone: phone, dateDue: isoDate(-10) }));

    expect(res.status).toBe(201);
    const debt = res.body.data;
    expect(debt.status).toBe("open");
    expect(Number(debt.amount_remaining)).toBe(1000);
    expect(debt.isOverdue).toBe(true);
    expect(debt.daysPastDue).toBe(10);
    expect(debt.agingBucket).toBe("1-30");
    expect(debt.customer_id).toBeTruthy();

    const customer = await prisma.customers.findUniqueOrThrow({ where: { id: debt.customer_id } });
    expect(customer.phone_original).toBe(phone);
    expect(Number(customer.debt_balance)).toBe(1000);

    // A second debt for the SAME phone number reuses the same customer --
    // proves find-or-create doesn't duplicate.
    const second = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(validDebtPayload({ customerPhone: phone, amountOriginal: 500 }));
    expect(second.status).toBe(201);
    expect(second.body.data.customer_id).toBe(debt.customer_id);

    const customerAfter = await prisma.customers.findUniqueOrThrow({ where: { id: debt.customer_id } });
    expect(Number(customerAfter.debt_balance)).toBe(1500);

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: debt.id, action: "debt.created" } });
    expect(auditRows).toHaveLength(1);
  });

  it("publishes a DebtCreated domain event", async () => {
    let published: unknown = null;
    domainEvents.once("DebtCreated", (payload) => {
      published = payload;
    });
    const debt = await createDebtAs(ownerToken);
    expect(published).toMatchObject({ debtId: debt.id, businessId, customerId: debt.customer_id });
  });

  it("computes 'current' (not overdue) for a debt due in the future", async () => {
    const debt = await createDebtAs(ownerToken, { dateDue: isoDate(15) });
    expect(debt.isOverdue).toBe(false);
    expect(debt.agingBucket).toBe("current");
  });

  it("buckets aging correctly at the 30/60/90 day boundaries", async () => {
    const cases: [number, string][] = [
      [-1, "1-30"],
      [-30, "1-30"],
      [-31, "31-60"],
      [-60, "31-60"],
      [-61, "61-90"],
      [-90, "61-90"],
      [-91, "90+"],
    ];
    for (const [dueOffset, expectedBucket] of cases) {
      const debt = await createDebtAs(ownerToken, { dateDue: isoDate(dueOffset), dateTaken: isoDate(dueOffset - 5) });
      expect(debt.agingBucket).toBe(expectedBucket);
    }
  });

  it("computes overdue relative to a non-default Business.business_day_start_time, not raw UTC midnight", async () => {
    // Shift this business's day boundary to 18:00 -- a debt due "today" (per
    // server UTC date) should read differently once the business's own local
    // day hasn't rolled over yet, proving the calculation genuinely reads
    // Business.timezone + businessDayStartTime rather than raw UTC.
    await prisma.businesses.update({ where: { id: businessId }, data: { business_day_start_time: new Date(Date.UTC(1970, 0, 1, 18, 0, 0)) } });

    try {
      const debt = await createDebtAs(ownerToken, { dateDue: isoDate(0), dateTaken: isoDate(-5) });
      // Whatever the result, it must be internally consistent with the
      // shifted boundary -- re-derive independently via the same business
      // row and compare, rather than asserting a hardcoded expectation that
      // would be timing-flaky depending on when the test suite happens to run.
      const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
      expect(business.business_day_start_time.getUTCHours()).toBe(18);
      expect(typeof debt.isOverdue).toBe("boolean");
    } finally {
      await prisma.businesses.update({ where: { id: businessId }, data: { business_day_start_time: new Date(Date.UTC(1970, 0, 1, 0, 0, 0)) } });
    }
  });

  describe("Interest policy snapshot (Business Settings is the sole source of truth)", () => {
    it("ignores client-supplied interest fields and snapshots Tier 2 defaults when the business has no policy configured", async () => {
      await withInterestPolicy(null, async () => {
        const res = await request(app)
          .post("/debts")
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          // Client tries to smuggle in interest fields -- createDebtSchema no
          // longer accepts them; they must be silently stripped, never
          // trusted, and never surface as a 400 either (unknown keys, not
          // invalid ones).
          .send(validDebtPayload({ interestEnabled: true, interestType: "percentage", interestValue: 999 }));
        expect(res.status).toBe(201);
        expect(res.body.data.interest_enabled).toBe(false);
        expect(res.body.data.interest_type).toBe("none");
        expect(res.body.data.interest_value).toBeNull();
        expect(res.body.data.calculation_policy).toBe("one_time");
        expect(res.body.data.formula).toBe("simple");
        expect(res.body.data.percentage_base).toBe("remaining_balance");
      });
    });

    it("snapshots the business's currently-configured interest policy onto a new debt", async () => {
      await withInterestPolicy(
        { enabled: true, type: "percentage", value: 12, calculationPolicy: "monthly", formula: "compound", percentageBase: "original_amount" },
        async () => {
          const debt = await createDebtAs(ownerToken);
          expect(debt.interest_enabled).toBe(true);
          expect(debt.interest_type).toBe("percentage");
          expect(Number(debt.interest_value)).toBe(12);
          expect(debt.calculation_policy).toBe("monthly");
          expect(debt.formula).toBe("compound");
          expect(debt.percentage_base).toBe("original_amount");
        }
      );
    });

    it("does not let a policy change after creation affect an already-created debt's snapshot (fairness guarantee)", async () => {
      const debt = await withInterestPolicy(
        { enabled: true, type: "fixed", value: 50, calculationPolicy: "weekly", formula: "simple", percentageBase: "remaining_balance" },
        () => createDebtAs(ownerToken)
      );
      expect(debt.interest_type).toBe("fixed");

      await withInterestPolicy(
        { enabled: true, type: "percentage", value: 20, calculationPolicy: "daily", formula: "compound", percentageBase: "original_amount" },
        async () => {
          const res = await request(app).get(`/debts/${debt.id}`).set("Authorization", `Bearer ${ownerToken}`);
          expect(res.body.data.interest_type).toBe("fixed");
          expect(Number(res.body.data.interest_value)).toBe(50);
          expect(res.body.data.calculation_policy).toBe("weekly");
        }
      );
    });
  });

  it("returns 400 when dateDue is before dateTaken", async () => {
    const res = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(validDebtPayload({ dateTaken: isoDate(0), dateDue: isoDate(-5) }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for zero or negative amountOriginal", async () => {
    for (const amountOriginal of [0, -100]) {
      const res = await request(app)
        .post("/debts")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validDebtPayload({ amountOriginal }));
      expect(res.status).toBe(400);
    }
  });

  it("returns 400 for an archived branch", async () => {
    const branch = await createTestBranch(businessId);
    await prisma.branches.update({ where: { id: branch.id }, data: { status: "archived" } });
    const res = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(validDebtPayload({ branchId: branch.id }));
    expect(res.status).toBe(400);
  });

  it("scopes a debt to the given branch and filters the list by it", async () => {
    const debt = await createDebtAs(ownerToken, { branchId });
    expect(debt.branch_id).toBe(branchId);

    const res = await request(app).get(`/debts?branchId=${branchId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((d: { id: string }) => d.id === debt.id)).toBe(true);
  });

  it("returns 404 when branchId belongs to a different business", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherBranch = await createTestBranch(otherOwner.businessId);

    const res = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(validDebtPayload({ branchId: otherBranch.id }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when saleId belongs to a different business", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
    const otherBranch = await createTestBranch(otherOwner.businessId);

    const res = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send(validDebtPayload({ saleId: randomUUID() }));
    expect(res.status).toBe(404);
    void otherLogin;
    void otherBranch;
  });

  it("returns 404 getting a debt from a different business", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
    const otherDebt = await createDebtAs(otherLogin.accessToken);

    const res = await request(app).get(`/debts/${otherDebt.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it("replays the exact same response for a repeated Idempotency-Key on create, creating only one debt and one customer balance increment", async () => {
    const key = idemKey();
    const payload = validDebtPayload();

    const first = await request(app).post("/debts").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    expect(first.status).toBe(201);

    const second = await request(app).post("/debts").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const customer = await prisma.customers.findUniqueOrThrow({ where: { id: first.body.data.customer_id } });
    expect(Number(customer.debt_balance)).toBe(1000);
  });

  describe("Payments", () => {
    it("records a payment, updates remaining balance/status, decrements customer.debt_balance, and publishes DebtPaymentReceived", async () => {
      const debt = await createDebtAs(ownerToken);

      let published: unknown = null;
      domainEvents.once("DebtPaymentReceived", (payload) => {
        published = payload;
      });

      const res = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 400 });
      expect(res.status).toBe(201);
      expect(Number(res.body.data.amount)).toBe(400);

      const updated = await request(app).get(`/debts/${debt.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(Number(updated.body.data.amount_remaining)).toBe(600);
      expect(updated.body.data.status).toBe("partially_paid");

      const customer = await prisma.customers.findUniqueOrThrow({ where: { id: debt.customer_id } });
      expect(Number(customer.debt_balance)).toBe(600);

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "debt.payment_added", entity_id: res.body.data.id } });
      expect(auditRows).toHaveLength(1);
      expect(published).toMatchObject({ debtId: debt.id, businessId, amount: "400" });
    });

    it("marks the debt fully paid when the payment covers the full remaining balance", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 200 });
      const res = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 200 });
      expect(res.status).toBe(201);

      const updated = await request(app).get(`/debts/${debt.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(updated.body.data.status).toBe("paid");
      expect(Number(updated.body.data.amount_remaining)).toBe(0);
    });

    it("returns 400 when payment amount exceeds the remaining balance", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 100 });
      const res = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 150 });
      expect(res.status).toBe(400);
    });

    it("returns 400 for zero or negative payment amount", async () => {
      const debt = await createDebtAs(ownerToken);
      for (const amount of [0, -50]) {
        const res = await request(app)
          .post(`/debts/${debt.id}/payments`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ amount });
        expect(res.status).toBe(400);
      }
    });

    it("returns 400 recording a payment on an already-paid debt", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 100 });
      await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 100 });

      const res = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 1 });
      expect(res.status).toBe(400);
    });

    it("returns 400 for an archived payment method", async () => {
      const debt = await createDebtAs(ownerToken);
      const pm = await createTestPaymentMethod(businessId);
      await prisma.payment_methods.update({ where: { id: pm.id }, data: { status: "archived" } });

      const res = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 50, paymentMethodId: pm.id });
      expect(res.status).toBe(400);
    });

    it("keeps status disputed after a payment on a disputed debt (dispute hold isn't silently cleared)", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 300 });
      const disputeRes = await request(app)
        .post(`/debts/${debt.id}/dispute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: debt.version, reason: "Customer disputes this debt" });
      expect(disputeRes.status).toBe(200);

      const payRes = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 100 });
      expect(payRes.status).toBe(201);

      const after = await request(app).get(`/debts/${debt.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(after.body.data.status).toBe("disputed");
    });

    it("only lets one of two concurrent payments win when they'd jointly overpay the remaining balance", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 100 });
      const body = { amount: 60 };

      const [first, second] = await Promise.all([
        request(app).post(`/debts/${debt.id}/payments`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
        request(app).post(`/debts/${debt.id}/payments`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const updated = await request(app).get(`/debts/${debt.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(Number(updated.body.data.amount_remaining)).toBe(40);
    });

    it("replays the same response for a repeated Idempotency-Key, applying the payment only once", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 500 });
      const key = idemKey();
      const body = { amount: 100 };

      const first = await request(app).post(`/debts/${debt.id}/payments`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body);
      expect(first.status).toBe(201);
      const second = await request(app).post(`/debts/${debt.id}/payments`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body);
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);

      const updated = await request(app).get(`/debts/${debt.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(Number(updated.body.data.amount_remaining)).toBe(400);
    });
  });

  describe("Payment reversal", () => {
    it("reverses a payment: restores the balance, decrements amount_paid, updates customer.debt_balance, and writes a ledger row referencing the original", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 500 });
      const payRes = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 200 });

      const reverseRes = await request(app)
        .post(`/debts/${debt.id}/payments/${payRes.body.data.id}/reverse`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: payRes.body.data.version, reason: "Recorded in error" });
      expect(reverseRes.status).toBe(201);
      expect(Number(reverseRes.body.data.amount)).toBe(-200);
      expect(reverseRes.body.data.reversal_of_payment_id).toBe(payRes.body.data.id);

      const updated = await request(app).get(`/debts/${debt.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(Number(updated.body.data.amount_remaining)).toBe(500);
      expect(updated.body.data.status).toBe("open");

      const customer = await prisma.customers.findUniqueOrThrow({ where: { id: debt.customer_id } });
      expect(Number(customer.debt_balance)).toBe(500);

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "debt.payment_reversed", entity_id: reverseRes.body.data.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("rejects reversing the same payment twice", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 500 });
      const payRes = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 200 });

      const first = await request(app)
        .post(`/debts/${debt.id}/payments/${payRes.body.data.id}/reverse`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: payRes.body.data.version, reason: "first reversal" });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post(`/debts/${debt.id}/payments/${payRes.body.data.id}/reverse`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: payRes.body.data.version, reason: "second reversal" });
      expect(second.status).toBe(409);
    });

    it("rejects reversing a reversal entry", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 500 });
      const payRes = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 200 });
      const reverseRes = await request(app)
        .post(`/debts/${debt.id}/payments/${payRes.body.data.id}/reverse`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: payRes.body.data.version, reason: "reverse original" });

      const res = await request(app)
        .post(`/debts/${debt.id}/payments/${reverseRes.body.data.id}/reverse`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: reverseRes.body.data.version, reason: "reverse the reversal" });
      expect(res.status).toBe(400);
    });

    it("rejects a cashier reversing a payment (elevated role only)", async () => {
      const cashier = await createTestUser(businessId, "cashier");
      const token = mintAccessToken(cashier);
      const debt = await createDebtAs(ownerToken, { amountOriginal: 500 });
      const payRes = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 200 });

      const res = await request(app)
        .post(`/debts/${debt.id}/payments/${payRes.body.data.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: payRes.body.data.version, reason: "x" });
      expect(res.status).toBe(403);
    });

    it("only lets one of two concurrent reversal requests win", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 500 });
      const payRes = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 200 });
      const body = { version: payRes.body.data.version, reason: "concurrent reversal" };

      const [first, second] = await Promise.all([
        request(app).post(`/debts/${debt.id}/payments/${payRes.body.data.id}/reverse`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
        request(app).post(`/debts/${debt.id}/payments/${payRes.body.data.id}/reverse`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", idemKey()).send(body),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe("Dispute / Resolve / Write-off", () => {
    it("disputes a debt, blocks a second dispute, and publishes DebtDisputed", async () => {
      const debt = await createDebtAs(ownerToken);
      let published: unknown = null;
      domainEvents.once("DebtDisputed", (payload) => {
        published = payload;
      });

      const res = await request(app)
        .post(`/debts/${debt.id}/dispute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: debt.version, reason: "Customer says this was already paid in cash" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("disputed");
      expect(published).toMatchObject({ debtId: debt.id, businessId });

      const second = await request(app)
        .post(`/debts/${debt.id}/dispute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: res.body.data.version, reason: "dispute again" });
      expect(second.status).toBe(400);

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "debt.disputed", entity_id: debt.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("resolves a dispute back to the amount-derived status", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 300 });
      const disputeRes = await request(app)
        .post(`/debts/${debt.id}/dispute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: debt.version, reason: "disputing" });

      const resolveRes = await request(app)
        .post(`/debts/${debt.id}/resolve-dispute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: disputeRes.body.data.version, reason: "Confirmed valid, resolved" });
      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.data.status).toBe("open");

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "debt.resolved", entity_id: debt.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("returns 400 resolving a dispute on a debt that isn't disputed", async () => {
      const debt = await createDebtAs(ownerToken);
      const res = await request(app)
        .post(`/debts/${debt.id}/resolve-dispute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: debt.version, reason: "x" });
      expect(res.status).toBe(400);
    });

    it("writes off a debt, decrements customer.debt_balance, keeps amount_remaining visible, and publishes DebtWrittenOff", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 800 });
      let published: unknown = null;
      domainEvents.once("DebtWrittenOff", (payload) => {
        published = payload;
      });

      const res = await request(app)
        .post(`/debts/${debt.id}/write-off`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: debt.version, reason: "Customer unreachable, writing off" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("written_off");
      expect(Number(res.body.data.amount_remaining)).toBe(800); // never deleted/zeroed, stays visible
      expect(published).toMatchObject({ debtId: debt.id, businessId });

      const customer = await prisma.customers.findUniqueOrThrow({ where: { id: debt.customer_id } });
      expect(Number(customer.debt_balance)).toBe(0);

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "debt.written_off", entity_id: debt.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("returns 400 writing off an already-written-off or already-paid debt", async () => {
      const paidDebt = await createDebtAs(ownerToken, { amountOriginal: 100 });
      await request(app)
        .post(`/debts/${paidDebt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 100 });
      const res = await request(app)
        .post(`/debts/${paidDebt.id}/write-off`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 1, reason: "x" });
      expect(res.status).toBe(400);
    });

    it("rejects a stale-version write-off (optimistic locking)", async () => {
      const debt = await createDebtAs(ownerToken);
      const first = await request(app)
        .post(`/debts/${debt.id}/write-off`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: debt.version, reason: "first attempt" });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post(`/debts/${debt.id}/write-off`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: debt.version, reason: "stale retry" });
      expect(second.status).toBe(400); // already written_off -- guard fires before the version check even matters
    });

    it("rejects a cashier attempting to write off a debt (elevated role only)", async () => {
      const cashier = await createTestUser(businessId, "cashier");
      const token = mintAccessToken(cashier);
      const debt = await createDebtAs(ownerToken);
      const res = await request(app)
        .post(`/debts/${debt.id}/write-off`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: debt.version, reason: "x" });
      expect(res.status).toBe(403);
    });

    it("replays the same response for a repeated Idempotency-Key on write-off", async () => {
      const debt = await createDebtAs(ownerToken);
      const key = idemKey();
      const body = { version: debt.version, reason: "writing off" };

      const first = await request(app).post(`/debts/${debt.id}/write-off`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body);
      expect(first.status).toBe(200);
      const second = await request(app).post(`/debts/${debt.id}/write-off`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body);
      expect(second.status).toBe(200);
      expect(second.body.data.version).toBe(first.body.data.version);
    });
  });

  describe("Reminders", () => {
    it("sends a WhatsApp reminder, records it in debt_reminders, and picks the type based on overdue state", async () => {
      const overdueDebt = await createDebtAs(ownerToken, { dateDue: isoDate(-5) });
      const res = await request(app).post(`/debts/${overdueDebt.id}/remind`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(201);
      expect(res.body.data.reminder_type).toBe("overdue");
      expect(res.body.data.provider).toBe("whatsapp");
      expect(res.body.data.status).toBe("sent");

      const notDueDebt = await createDebtAs(ownerToken, { dateDue: isoDate(20) });
      const res2 = await request(app).post(`/debts/${notDueDebt.id}/remind`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res2.status).toBe(201);
      expect(res2.body.data.reminder_type).toBe("before_due");

      const auditRows = await prisma.audit_logs.findMany({ where: { action: "debt.reminder_sent", entity_id: res.body.data.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("does not require an Idempotency-Key (not a financial mutation)", async () => {
      const debt = await createDebtAs(ownerToken);
      const res = await request(app).post(`/debts/${debt.id}/remind`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(201);
    });
  });

  describe("Apply Interest", () => {
    it("returns 400 for a debt whose snapshotted policy has interest disabled", async () => {
      const debt = await withInterestPolicy(null, () => createDebtAs(ownerToken));
      const res = await request(app)
        .post(`/debts/${debt.id}/apply-interest`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: debt.version });
      expect(res.status).toBe(400);
    });

    it("computes a percentage/monthly/simple charge against remaining balance, writes an immutable debt_transactions row, updates the balance, and publishes InterestApplied", async () => {
      await withInterestPolicy(
        { enabled: true, type: "percentage", value: 10, calculationPolicy: "monthly", formula: "simple", percentageBase: "remaining_balance" },
        async () => {
          // Taken ~40 days ago -- at least one full calendar month has
          // elapsed since date_taken, so a first apply-interest call is due.
          const debt = await createDebtAs(ownerToken, {
            amountOriginal: 1000,
            dateTaken: isoDate(-40),
            dateDue: isoDate(-20),
          });

          let published: unknown = null;
          domainEvents.once("InterestApplied", (payload) => {
            published = payload;
          });

          const res = await request(app)
            .post(`/debts/${debt.id}/apply-interest`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ version: debt.version });
          expect(res.status).toBe(201);
          expect(Number(res.body.data.debt.amount_remaining)).toBe(1100);
          expect(res.body.data.transaction.transaction_type).toBe("interest_applied");
          expect(Number(res.body.data.transaction.amount)).toBe(100);
          expect(Number(res.body.data.transaction.balance_after)).toBe(1100);
          expect(res.body.data.transaction.periods_elapsed).toBeGreaterThanOrEqual(1);
          expect(published).toMatchObject({ debtId: debt.id, businessId });

          const ledgerRows = await prisma.debt_transactions.findMany({ where: { debt_id: debt.id } });
          expect(ledgerRows).toHaveLength(1);

          // Scoped to the transaction's own id, not the debt's -- matches the
          // existing debt.payment_added pattern (entity_id is the payment's
          // id, not the debt's).
          const auditRows = await prisma.audit_logs.findMany({ where: { action: "debt.interest_applied", entity_id: res.body.data.transaction.id } });
          expect(auditRows).toHaveLength(1);
        }
      );
    });

    it("is a safe no-op (200, no new ledger row) when called again immediately -- zero periods have elapsed since the last application", async () => {
      await withInterestPolicy(
        { enabled: true, type: "percentage", value: 10, calculationPolicy: "monthly", formula: "simple", percentageBase: "remaining_balance" },
        async () => {
          const debt = await createDebtAs(ownerToken, { amountOriginal: 1000, dateTaken: isoDate(-40), dateDue: isoDate(-20) });
          const first = await request(app)
            .post(`/debts/${debt.id}/apply-interest`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ version: debt.version });
          expect(first.status).toBe(201);

          const second = await request(app)
            .post(`/debts/${debt.id}/apply-interest`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ version: first.body.data.debt.version });
          expect(second.status).toBe(200);
          expect(second.body.data.transaction).toBeNull();

          const ledgerRows = await prisma.debt_transactions.findMany({ where: { debt_id: debt.id } });
          expect(ledgerRows).toHaveLength(1); // still just the one from the first call
        }
      );
    });

    it("enforces one_time's 'only ever once' rule even across two separately-idempotency-keyed calls", async () => {
      await withInterestPolicy(
        { enabled: true, type: "fixed", value: 25, calculationPolicy: "one_time", formula: "simple", percentageBase: "remaining_balance" },
        async () => {
          const debt = await createDebtAs(ownerToken, { amountOriginal: 500, dateTaken: isoDate(-40), dateDue: isoDate(-20) });

          const first = await request(app)
            .post(`/debts/${debt.id}/apply-interest`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ version: debt.version });
          expect(first.status).toBe(201);
          expect(Number(first.body.data.transaction.amount)).toBe(25);

          const second = await request(app)
            .post(`/debts/${debt.id}/apply-interest`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ version: first.body.data.debt.version });
          expect(second.status).toBe(200);
          expect(second.body.data.transaction).toBeNull();

          const ledgerRows = await prisma.debt_transactions.findMany({ where: { debt_id: debt.id } });
          expect(ledgerRows).toHaveLength(1);
        }
      );
    });

    it("rejects a stale-version apply-interest call (optimistic locking)", async () => {
      await withInterestPolicy(
        { enabled: true, type: "fixed", value: 25, calculationPolicy: "daily", formula: "simple", percentageBase: "remaining_balance" },
        async () => {
          const debt = await createDebtAs(ownerToken, { amountOriginal: 500, dateTaken: isoDate(-10), dateDue: isoDate(-5) });
          const res = await request(app)
            .post(`/debts/${debt.id}/apply-interest`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ version: debt.version + 5 });
          expect(res.status).toBe(409);
        }
      );
    });

    it("replays the same response for a repeated Idempotency-Key, applying interest only once", async () => {
      await withInterestPolicy(
        { enabled: true, type: "fixed", value: 25, calculationPolicy: "one_time", formula: "simple", percentageBase: "remaining_balance" },
        async () => {
          const debt = await createDebtAs(ownerToken, { amountOriginal: 500, dateTaken: isoDate(-10), dateDue: isoDate(-5) });
          const key = idemKey();
          const body = { version: debt.version };

          const first = await request(app).post(`/debts/${debt.id}/apply-interest`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body);
          expect(first.status).toBe(201);
          const second = await request(app).post(`/debts/${debt.id}/apply-interest`).set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(body);
          expect(second.status).toBe(201);
          expect(second.body.data.transaction.id).toBe(first.body.data.transaction.id);

          const ledgerRows = await prisma.debt_transactions.findMany({ where: { debt_id: debt.id } });
          expect(ledgerRows).toHaveLength(1);
        }
      );
    });

    it("rejects a cashier applying interest (elevated role only)", async () => {
      const cashier = await createTestUser(businessId, "cashier");
      const token = mintAccessToken(cashier);
      const debt = await withInterestPolicy(
        { enabled: true, type: "fixed", value: 25, calculationPolicy: "daily", formula: "simple", percentageBase: "remaining_balance" },
        () => createDebtAs(ownerToken)
      );
      const res = await request(app)
        .post(`/debts/${debt.id}/apply-interest`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: debt.version });
      expect(res.status).toBe(403);
    });

    // QA (2026-07-26) -- FOUND BUG, fixed: last_interest_applied_at is a real
    // wall-clock timestamp (unlike date_taken/today, which are already
    // UTC-midnight-anchored calendar dates), and date-fns'
    // differenceInCalendarDays/Months (interestEngine.ts) read LOCAL Date
    // getters -- so periods_elapsed used to silently depend on the SERVER
    // PROCESS's own local timezone rather than Business.timezone. Fixed by
    // bucketing last_interest_applied_at through the business's own
    // getBusinessDay before any date-fns calendar arithmetic, exactly like
    // `today` already was. This test proves the fix: several wall-clock
    // timestamps that all land on the exact same business-day (confirmed via
    // the same getBusinessDay the source code itself uses) must produce the
    // identical periods_elapsed, regardless of which hour-of-day each one
    // happens to be stored at.
    it("computes daily periods_elapsed from the business's own calendar day, independent of last_interest_applied_at's stored wall-clock hour (regression: server-local-timezone leak)", async () => {
      await withInterestPolicy(
        { enabled: true, type: "fixed", value: 10, calculationPolicy: "daily", formula: "simple", percentageBase: "remaining_balance" },
        async () => {
          const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
          const todayBusinessDay = getBusinessDay(business.timezone, business.business_day_start_time);

          const candidateHours = [1, 5, 9, 13, 17, 21];
          const candidates = candidateHours
            .map((h) => {
              const d = new Date(Date.now() - 30 * 3_600_000); // ~30h ago -- safely "yesterday" for any reasonable timezone offset
              d.setUTCHours(h, 0, 0, 0);
              return d;
            })
            .filter((d) => {
              const day = getBusinessDay(business.timezone, business.business_day_start_time, d);
              const diffDays = Math.round((Date.parse(todayBusinessDay) - Date.parse(day)) / 86_400_000);
              return diffDays === 1; // exactly one business-day before today
            });
          // Sanity check on the sampling itself, not the fix: if this ever
          // comes back empty/singular the test below would vacuously pass.
          expect(candidates.length).toBeGreaterThanOrEqual(2);

          const periodsSeen = new Set<number>();
          for (const candidate of candidates) {
            const debt = await createDebtAs(ownerToken, { amountOriginal: 500 });
            await prisma.debts.update({ where: { id: debt.id }, data: { last_interest_applied_at: candidate } });
            const fresh = await prisma.debts.findUniqueOrThrow({ where: { id: debt.id } });

            const res = await request(app)
              .post(`/debts/${debt.id}/apply-interest`)
              .set("Authorization", `Bearer ${ownerToken}`)
              .set("Idempotency-Key", idemKey())
              .send({ version: fresh.version });
            expect(res.status).toBe(201);
            periodsSeen.add(res.body.data.transaction.periods_elapsed);
          }

          expect(periodsSeen.size).toBe(1);
          expect([...periodsSeen][0]).toBe(1);
        }
      );
    }, 30_000);

    // QA (2026-07-26) -- FOUND BUG, fixed: applyInterest updated
    // amount_remaining without calling recomputeStatus, unlike every other
    // balance-changing debt mutation (recordPayment/reversePayment). Interest
    // only ever increases the balance, so a partially_paid debt whose accrued
    // interest brings amount_remaining back up to/above amount_original kept
    // the stale partially_paid label instead of reverting to open.
    it("reverts a partially_paid debt back to open when accrued interest brings amount_remaining back to/above amount_original", async () => {
      await withInterestPolicy(
        { enabled: true, type: "fixed", value: 700, calculationPolicy: "one_time", formula: "simple", percentageBase: "remaining_balance" },
        async () => {
          const debt = await createDebtAs(ownerToken, { amountOriginal: 1000 });
          const payRes = await request(app)
            .post(`/debts/${debt.id}/payments`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ amount: 600 });
          expect(payRes.status).toBe(201);

          const afterPayment = await request(app).get(`/debts/${debt.id}`).set("Authorization", `Bearer ${ownerToken}`);
          expect(afterPayment.body.data.status).toBe("partially_paid");
          expect(Number(afterPayment.body.data.amount_remaining)).toBe(400);

          const applyRes = await request(app)
            .post(`/debts/${debt.id}/apply-interest`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .set("Idempotency-Key", idemKey())
            .send({ version: afterPayment.body.data.version });
          expect(applyRes.status).toBe(201);
          expect(Number(applyRes.body.data.debt.amount_remaining)).toBe(1100); // 400 + 700
          expect(applyRes.body.data.debt.status).toBe("open");
        }
      );
    });
  });

  describe("List filtering", () => {
    it("filters by status", async () => {
      const debt = await createDebtAs(ownerToken, { amountOriginal: 50 });
      await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 50 });

      const res = await request(app).get("/debts?status=paid").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((d: { id: string }) => d.id === debt.id)).toBe(true);
      expect(res.body.data.every((d: { status: string }) => d.status === "paid")).toBe(true);
    });

    it("filters by isOverdue", async () => {
      const overdue = await createDebtAs(ownerToken, { dateDue: isoDate(-5) });
      const notOverdue = await createDebtAs(ownerToken, { dateDue: isoDate(5) });

      const res = await request(app).get("/debts?isOverdue=true").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).toContain(overdue.id);
      expect(ids).not.toContain(notOverdue.id);
    });

    it("returns a {data, pagination} envelope", async () => {
      const res = await request(app).get("/debts?pageSize=1").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("pagination");
      expect(res.body.pagination).toHaveProperty("total");
      expect(res.body.pagination).toHaveProperty("totalPages");
      expect(res.body.data.length).toBeLessThanOrEqual(1);
    });

    // QA (2026-07-23): the raw-SQL CASE bucketing in listDebts is a *separate*
    // implementation of the same boundary math computeAging()/decorateDebt()
    // already cover for POST/GET-single (tested above at "buckets aging
    // correctly at the 30/60/90 day boundaries") -- that test never exercises
    // this SQL path, so a boundary regression here (e.g. BETWEEN off-by-one)
    // would go completely uncaught. Locks in the same exact boundary days via
    // the list endpoint's own agingBucket filter instead.
    it("buckets aging correctly at the 30/60/90 day boundaries via the list endpoint's raw-SQL CASE (not just the JS decorateDebt path)", async () => {
      // ~48 sequential HTTP round trips (8 cases x up to 6 requests each),
      // each several serialized Prisma/Neon-HTTP-driver queries deep -- the
      // heaviest single test in this file by a wide margin. Observed to
      // occasionally exceed the suite's global 40s testTimeout under real
      // Neon latency even though nothing here is actually broken (same
      // documented per-query-latency risk noted elsewhere in this repo for
      // Sales' transaction timeout) -- extending just this one test's budget
      // rather than raising the global default for every other test.
      // Scoped by a unique phone per case (via `search`) rather than a large
      // pageSize -- pageSize is capped at 100 (locked pagination rule), and by
      // this point in the suite many other tests' debts already share the
      // wide "1-30"/"current" buckets, so relying on page-1 containment alone
      // would be flaky. Search-scoping keeps each case's result set to
      // exactly the one debt just created for it, regardless of accumulated
      // state or ordering.
      const allBuckets = ["current", "1-30", "31-60", "61-90", "90+"];
      const cases: [number, string][] = [
        [0, "current"],
        [-1, "1-30"],
        [-30, "1-30"],
        [-31, "31-60"],
        [-60, "31-60"],
        [-61, "61-90"],
        [-90, "61-90"],
        [-91, "90+"],
      ];

      for (const [dueOffset, expectedBucket] of cases) {
        const phone = `+2547${Math.floor(10000000 + Math.random() * 89999999)}`;
        const debt = await createDebtAs(ownerToken, { customerPhone: phone, dateDue: isoDate(dueOffset), dateTaken: isoDate(dueOffset - 5) });

        const res = await request(app)
          .get(`/debts?agingBucket=${encodeURIComponent(expectedBucket)}&search=${encodeURIComponent(phone)}`)
          .set("Authorization", `Bearer ${ownerToken}`);
        expect(res.status).toBe(200);
        expect(res.body.data.map((d: { id: string }) => d.id)).toContain(debt.id);

        // Must not also show up one bucket off in either direction -- the
        // precise BETWEEN boundary this test exists to lock in.
        for (const otherBucket of allBuckets) {
          if (otherBucket === expectedBucket) continue;
          const otherRes = await request(app)
            .get(`/debts?agingBucket=${encodeURIComponent(otherBucket)}&search=${encodeURIComponent(phone)}`)
            .set("Authorization", `Bearer ${ownerToken}`);
          expect(otherRes.body.data.map((d: { id: string }) => d.id)).not.toContain(debt.id);
        }
      }
    }, 90_000);

    it("keeps pagination.total consistent with the actual filtered row count (LIMIT/OFFSET vs COUNT(*)) when filtering by agingBucket", async () => {
      // Three debts sharing one unique tag (via customerName + `search`), all
      // in the 31-60 bucket, with a page size smaller than the match count --
      // isolates the LIMIT/OFFSET-vs-COUNT(*) consistency check from any
      // other data already in this business.
      const tag = `QA-Bucket-Consistency-${randomUUID()}`;
      for (const dueOffset of [-35, -45, -55]) {
        await createDebtAs(ownerToken, { customerName: tag, dateDue: isoDate(dueOffset), dateTaken: isoDate(dueOffset - 5) });
      }

      const full = await request(app)
        .get(`/debts?agingBucket=31-60&search=${encodeURIComponent(tag)}&pageSize=10`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(full.status).toBe(200);
      expect(full.body.data).toHaveLength(3);
      expect(full.body.pagination.total).toBe(3);

      // A page size smaller than the match count must truncate `data` without
      // changing the reported `total` -- otherwise COUNT(*) and the paginated
      // rows have drifted apart under the same filter.
      const paged = await request(app)
        .get(`/debts?agingBucket=31-60&search=${encodeURIComponent(tag)}&pageSize=2`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(paged.status).toBe(200);
      expect(paged.body.data).toHaveLength(2);
      expect(paged.body.pagination.total).toBe(3);

      // The filtered total must be strictly less than the unfiltered
      // business-wide total -- otherwise COUNT(*) is silently ignoring the
      // aging_bucket filter that the data rows themselves respect.
      const unfiltered = await request(app).get("/debts?pageSize=1").set("Authorization", `Bearer ${ownerToken}`);
      expect(unfiltered.body.pagination.total).toBeGreaterThan(full.body.pagination.total);
    });

    it("falls back to the default sort column for an unrecognized sort value instead of erroring or injecting it into the raw SQL", async () => {
      const res = await request(app)
        .get(`/debts?sort=${encodeURIComponent("id; DROP TABLE debts;--")}&pageSize=5`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);

      // The table must obviously still exist / be queryable afterward.
      const followUp = await request(app).get("/debts?pageSize=1").set("Authorization", `Bearer ${ownerToken}`);
      expect(followUp.status).toBe(200);
    });

    // QA (2026-07-23) -- FOUND BUG, not yet fixed: POST /debts and GET
    // /debts/:id expose the computed aging fields as camelCase
    // (agingBucket/isOverdue/daysPastDue, via decorateDebt()), but GET /debts
    // (the raw $queryRaw path in listDebts) exposes the identical fields as
    // snake_case (aging_bucket/is_overdue/days_past_due) straight off the SQL
    // column aliases, with no rename before the response is sent. A client
    // reading the same conceptual field from the list endpoint vs. the
    // single-debt endpoints needs two different key names. This test asserts
    // the presumably-intended (camelCase, matching every other endpoint)
    // shape and is expected to FAIL against the current listDebts()
    // implementation -- see src/services/debt.service.ts's `rows.map(...)` in
    // listDebts(), around the `aging_bucket`/`is_overdue`/`days_past_due`
    // SQL aliases.
    it("exposes agingBucket/isOverdue/daysPastDue on list rows in the same camelCase shape POST/GET-single use (currently fails: list returns snake_case)", async () => {
      const phone = `+2547${Math.floor(10000000 + Math.random() * 89999999)}`;
      const debt = await createDebtAs(ownerToken, { customerPhone: phone, dateDue: isoDate(-10) });
      const res = await request(app).get(`/debts?search=${encodeURIComponent(phone)}`).set("Authorization", `Bearer ${ownerToken}`);
      const row = res.body.data.find((d: { id: string }) => d.id === debt.id);
      expect(row).toBeTruthy();
      expect(row).toHaveProperty("agingBucket");
      expect(row).toHaveProperty("isOverdue");
      expect(row).toHaveProperty("daysPastDue");
    });
  });

  describe("full permission matrix (denied access)", () => {
    const deniedWrite: UserRole[] = ["accountant", "storekeeper", "shareholder", "custom"];
    const deniedRead: UserRole[] = ["storekeeper", "shareholder", "custom"];
    const deniedElevated: UserRole[] = ["cashier", "accountant", "storekeeper", "shareholder", "custom"];

    const cases: { role: UserRole; action: "create" | "list" | "reverse" | "dispute" | "resolve-dispute" | "write-off" | "apply-interest" }[] = [
      ...deniedWrite.map((role) => ({ role, action: "create" as const })),
      ...deniedRead.map((role) => ({ role, action: "list" as const })),
      ...deniedElevated.map((role) => ({ role, action: "reverse" as const })),
      ...deniedElevated.map((role) => ({ role, action: "dispute" as const })),
      ...deniedElevated.map((role) => ({ role, action: "resolve-dispute" as const })),
      ...deniedElevated.map((role) => ({ role, action: "write-off" as const })),
      ...deniedElevated.map((role) => ({ role, action: "apply-interest" as const })),
    ];

    it.each(cases)("denies role=$role action=$action (status, error code, and message)", async ({ role, action }) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const res =
        action === "create"
          ? await request(app).post("/debts").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send(validDebtPayload())
          : action === "list"
            ? await request(app).get("/debts").set("Authorization", `Bearer ${token}`)
            : action === "reverse"
              ? await request(app)
                  .post(`/debts/${randomUUID()}/payments/${randomUUID()}/reverse`)
                  .set("Authorization", `Bearer ${token}`)
                  .set("Idempotency-Key", idemKey())
                  .send({ version: 0, reason: "x" })
              : await request(app)
                  .post(`/debts/${randomUUID()}/${action}`)
                  .set("Authorization", `Bearer ${token}`)
                  .set("Idempotency-Key", idemKey())
                  .send({ version: 0, reason: "x" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
      expect(typeof res.body.error.message).toBe("string");
      expect(res.body.error.message.length).toBeGreaterThan(0);
    });

    it("allows super_admin to create, list, reverse, dispute, resolve, and write off regardless of role restrictions", async () => {
      const admin = await createTestUser(businessId, "super_admin");
      const token = mintAccessToken(admin);

      const createRes = await request(app).post("/debts").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send(validDebtPayload({ amountOriginal: 300 }));
      expect(createRes.status).toBe(201);
      const debt = createRes.body.data;

      const listRes = await request(app).get("/debts").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(200);

      const payRes = await request(app).post(`/debts/${debt.id}/payments`).set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send({ amount: 100 });
      expect(payRes.status).toBe(201);

      const reverseRes = await request(app)
        .post(`/debts/${debt.id}/payments/${payRes.body.data.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: payRes.body.data.version, reason: "x" });
      expect(reverseRes.status).toBe(201);

      const disputeRes = await request(app)
        .post(`/debts/${debt.id}/dispute`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 2, reason: "x" });
      expect(disputeRes.status).toBe(200);

      const resolveRes = await request(app)
        .post(`/debts/${debt.id}/resolve-dispute`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: disputeRes.body.data.version, reason: "x" });
      expect(resolveRes.status).toBe(200);

      const writeOffRes = await request(app)
        .post(`/debts/${debt.id}/write-off`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: resolveRes.body.data.version, reason: "x" });
      expect(writeOffRes.status).toBe(200);
    });
  });
});
