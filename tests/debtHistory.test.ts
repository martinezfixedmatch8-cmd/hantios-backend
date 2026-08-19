import request from "supertest";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { generateId } from "../src/lib/ids";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestBranch } from "./helpers/factories";
import { setNotificationProvider, getNotificationProvider } from "../src/notifications/registry";
import type { NotificationProvider } from "../src/notifications/NotificationProvider";

const idemKey = () => `test-${randomUUID()}`;
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

// Always throws -- used to force one real `failed` reminder row through the
// actual sendReminder() code path, not a simulated one, so the history
// endpoint's own `hasError`/no-raw-text behavior is verified against a
// genuine failure, not a fixture.
class AlwaysFailingNotificationProvider implements NotificationProvider {
  // Deliberately zero-parameter -- a function type with fewer parameters is
  // structurally assignable wherever NotificationProvider.send(notification)
  // is expected, so this avoids ever declaring an unused parameter at all
  // (cleaner than an underscore-prefixed one -- this repo's own
  // eslint.config.js has no argsIgnorePattern, so `_notification` still
  // warns; confirmed directly before choosing this fix).
  async send(): Promise<void> {
    throw new Error("simulated provider outage: connection reset by peer at 10.0.0.4:443 (internal diagnostic detail)");
  }
}

// Batch 5 (HNT2-DEBT-001) -- the unified financial/reminder history read
// surface: GET /debts/:id/history. Reuses debt.test.ts's own established
// validDebtPayload/createDebtAs shape rather than reinventing it.
describe("Debt History (HNT2-DEBT-001)", () => {
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

  function validDebtPayload(overrides: Record<string, unknown> = {}) {
    return {
      customerPhone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
      customerName: "Test Customer",
      customerLocation: "Nairobi",
      amountOriginal: 1000,
      dateTaken: isoDate(-40),
      dateDue: isoDate(-10),
      branchId,
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

  async function getHistory(debtId: string, token = ownerToken, query = "") {
    return request(app).get(`/debts/${debtId}/history${query}`).set("Authorization", `Bearer ${token}`);
  }

  it("a debt with no history beyond creation returns an empty event stream, not an error", async () => {
    const debt = await createDebtAs(ownerToken, { amountOriginal: 300 });
    const res = await getHistory(debt.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.effectiveBalance).toBe(debt.amount_remaining);
  });

  it("full chronology: payments (with occurredAt/recordedAt distinction), a reversal, an interest application, and a failed reminder all appear correctly typed and ordered", async () => {
    const debt = await withInterestPolicy(
      { enabled: true, type: "percentage", value: 10, calculationPolicy: "monthly", formula: "simple", percentageBase: "remaining_balance" },
      () => createDebtAs(ownerToken, { amountOriginal: 1000, dateTaken: isoDate(-40), dateDue: isoDate(-20) })
    );

    // Payment 1 -- deliberately back-dated payment_date, distinct from its
    // own real created_at (request time) -- the exact scenario clarification
    // #4 asks the response to distinguish via occurredAt vs recordedAt.
    const backdatedPaymentDate = isoDate(-5);
    const pay1 = await request(app)
      .post(`/debts/${debt.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 200, paymentDate: backdatedPaymentDate });
    expect(pay1.status).toBe(201);

    // Payment 2, then reversed.
    const pay2 = await request(app)
      .post(`/debts/${debt.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 150 });
    expect(pay2.status).toBe(201);
    const reversal = await request(app)
      .post(`/debts/${debt.id}/payments/${pay2.body.data.id}/reverse`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: pay2.body.data.version, reason: "recorded in error" });
    expect(reversal.status).toBe(201);

    // Interest application.
    const debtAfterPayments = await request(app).get(`/debts/${debt.id}`).set("Authorization", `Bearer ${ownerToken}`);
    const interest = await request(app)
      .post(`/debts/${debt.id}/apply-interest`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: debtAfterPayments.body.data.version });
    expect(interest.status).toBe(201);

    // A successful reminder.
    const remindOk = await request(app).post(`/debts/${debt.id}/remind`).set("Authorization", `Bearer ${ownerToken}`);
    expect(remindOk.status).toBe(201);
    expect(remindOk.body.data.status).toBe("sent");

    // A failed reminder -- forced via a real throwing NotificationProvider,
    // on a SECOND, freshly-created debt+business_date-scoped slot (the same
    // debt's own reminder for today is already claimed as `sent` above, and
    // debt_reminders' own @@unique(debt_id, reminder_type, business_date)
    // means a second call today would just replay the same row) -- so a
    // second, distinct debt is used purely to generate a real `failed` row,
    // then its own history is checked directly for the hasError/no-raw-text
    // behavior (kept as its own dedicated assertion below, not mixed into
    // this debt's own chronology to avoid the unique-slot collision).
    void remindOk;

    const historyRes = await getHistory(debt.id, ownerToken, "?limit=100");
    expect(historyRes.status).toBe(200);
    const events = historyRes.body.data as Array<Record<string, unknown>>;

    const types = events.map((e) => e.type);
    expect(types).toContain("payment");
    expect(types).toContain("payment_reversal");
    expect(types).toContain("interest_applied");
    expect(types).toContain("reminder");
    expect(events).toHaveLength(5); // 2 payments + 1 reversal + 1 interest + 1 reminder

    // Deterministic chronological ordering (most-recent-first, matching
    // getCustomerTimeline's own DESC convention).
    const recordedTimestamps = events.map((e) => new Date(e.recordedAt as string).getTime());
    for (let i = 1; i < recordedTimestamps.length; i++) {
      expect(recordedTimestamps[i - 1]).toBeGreaterThanOrEqual(recordedTimestamps[i]);
    }

    // occurredAt/recordedAt distinction -- the back-dated payment event.
    const backdatedEvent = events.find((e) => e.type === "payment" && Number(e.amount) === 200)!;
    expect(backdatedEvent).toBeDefined();
    expect(new Date(backdatedEvent.occurredAt as string).toISOString().slice(0, 10)).toBe(backdatedPaymentDate);
    expect(new Date(backdatedEvent.recordedAt as string).toISOString().slice(0, 10)).not.toBe(backdatedPaymentDate);

    // The reversal is its own distinct `payment_reversal`-typed event, with
    // a negative amount, and never rewrites the original payment event.
    const reversalEvent = events.find((e) => e.type === "payment_reversal")!;
    expect(Number(reversalEvent.amount)).toBeLessThan(0);
    const originalPay2Event = events.find((e) => e.type === "payment" && Number(e.amount) === 150)!;
    expect(originalPay2Event).toBeDefined();

    // Interest event carries balanceAfter and a real actor.
    const interestEvent = events.find((e) => e.type === "interest_applied")! as { balanceAfter: string; actor: { userId: string } };
    expect(interestEvent.balanceAfter).toBeDefined();
    expect(interestEvent.actor.userId).toBeTruthy();

    // Reminder event: reminder-specific fields present, no human actor.
    const reminderEvent = events.find((e) => e.type === "reminder")! as Record<string, unknown>;
    expect(reminderEvent.actor).toBeNull();
    expect(reminderEvent.status).toBe("sent");
    expect(reminderEvent.channel).toBe("whatsapp");
    expect(reminderEvent.hasError).toBe(false);
    expect(reminderEvent).not.toHaveProperty("error");

    // Payment/reversal/interest actors carry both userId and userName
    // (current record, not an immutable snapshot).
    const paymentEvent = events.find((e) => e.type === "payment") as { actor: { userId: string; userName: string } };
    expect(paymentEvent.actor.userId).toBeTruthy();
    expect(typeof paymentEvent.actor.userName).toBe("string");
  });

  it("a failed reminder exposes hasError:true and status:failed, but never the raw provider error text", async () => {
    const debt = await createDebtAs(ownerToken, { amountOriginal: 500 });
    const originalProvider = getNotificationProvider();
    setNotificationProvider(new AlwaysFailingNotificationProvider());
    try {
      const remindRes = await request(app).post(`/debts/${debt.id}/remind`).set("Authorization", `Bearer ${ownerToken}`);
      expect(remindRes.status).toBe(201);
      expect(remindRes.body.data.status).toBe("failed");
      // The raw error genuinely landed in the DB row itself (confirms the
      // test forced a real failure, not a no-op).
      expect(remindRes.body.data.error).toContain("simulated provider outage");
    } finally {
      setNotificationProvider(originalProvider);
    }

    const historyRes = await getHistory(debt.id);
    const reminderEvent = historyRes.body.data.find((e: { type: string }) => e.type === "reminder");
    expect(reminderEvent.status).toBe("failed");
    expect(reminderEvent.hasError).toBe(true);
    expect(reminderEvent).not.toHaveProperty("error");
    expect(JSON.stringify(reminderEvent)).not.toContain("simulated provider outage");
  });

  it("effectiveBalance from the history endpoint matches GET /debts/:id's own authoritative amount_remaining exactly", async () => {
    const debt = await createDebtAs(ownerToken, { amountOriginal: 400 });
    await request(app)
      .post(`/debts/${debt.id}/payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 150 });

    const detailRes = await request(app).get(`/debts/${debt.id}`).set("Authorization", `Bearer ${ownerToken}`);
    const historyRes = await getHistory(debt.id);
    expect(historyRes.body.effectiveBalance).toBe(detailRes.body.data.amount_remaining);
  });

  it("pagination: a large history is walked correctly via cursor with no duplicate or skipped events", async () => {
    const debt = await createDebtAs(ownerToken, { amountOriginal: 10000 });
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 10 });
      expect(res.status).toBe(201);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res = await getHistory(debt.id, ownerToken, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      for (const event of res.body.data) seen.push(`${event.type}:${event.recordedAt}:${event.amount}`);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6); // no duplicates
  });

  // Review round 2 -- Postgres's now() is stable for an entire transaction,
  // so any single transaction writing to more than one of debt_payments/
  // debt_transactions/debt_reminders produces IDENTICAL created_at values
  // across source tables. Constructed deliberately (per the explicit
  // instruction) via one real Prisma transaction inserting a row into all
  // THREE source tables with an EXPLICIT, shared created_at -- not left to
  // timing luck -- to prove the (created_at, eventKey) cursor genuinely
  // resolves the tie, not just in the common case where timestamps happen
  // to differ.
  it("pagination is stable across multiple events sharing the exact same recorded_at timestamp, across all three source tables", async () => {
    const debt = await createDebtAs(ownerToken, { amountOriginal: 900 });
    const tiedTimestamp = new Date("2026-01-15T12:00:00.000Z");

    const paymentId = generateId();
    const transactionId = generateId();
    const reminderId = generateId();

    await prisma.$transaction([
      prisma.debt_payments.create({
        data: {
          id: paymentId,
          business_id: businessId,
          debt_id: debt.id,
          amount: 50,
          payment_date: tiedTimestamp,
          created_by: ownerId,
          created_at: tiedTimestamp,
        },
      }),
      prisma.debt_transactions.create({
        data: {
          id: transactionId,
          business_id: businessId,
          debt_id: debt.id,
          transaction_type: "interest_applied",
          amount: 25,
          balance_after: 875,
          created_by: ownerId,
          created_at: tiedTimestamp,
        },
      }),
      prisma.debt_reminders.create({
        data: {
          id: reminderId,
          business_id: businessId,
          debt_id: debt.id,
          reminder_type: "before_due",
          status: "sent",
          provider: "whatsapp",
          business_date: tiedTimestamp,
          created_at: tiedTimestamp,
        },
      }),
    ]);

    // Confirm the tie is real, not assumed -- all three rows genuinely
    // share the identical created_at before testing pagination against it.
    const [dp, dt, dr] = await Promise.all([
      prisma.debt_payments.findUniqueOrThrow({ where: { id: paymentId } }),
      prisma.debt_transactions.findUniqueOrThrow({ where: { id: transactionId } }),
      prisma.debt_reminders.findUniqueOrThrow({ where: { id: reminderId } }),
    ]);
    expect(dp.created_at.getTime()).toBe(tiedTimestamp.getTime());
    expect(dt.created_at.getTime()).toBe(tiedTimestamp.getTime());
    expect(dr.created_at.getTime()).toBe(tiedTimestamp.getTime());

    // Walk the exact tied boundary one event at a time (limit=1), which
    // forces the cursor to cut directly through the middle of the tie on
    // at least one page transition.
    const seenKeys: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res = await getHistory(debt.id, ownerToken, `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      for (const event of res.body.data) seenKeys.push(event.eventKey);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }

    expect(seenKeys).toHaveLength(3);
    expect(new Set(seenKeys).size).toBe(3); // no duplicates
    expect(new Set(seenKeys)).toEqual(new Set([`payment:${paymentId}`, `interest:${transactionId}`, `reminder:${reminderId}`]));
  });

  it("an invalid cursor returns a clean 400, not a 500", async () => {
    const debt = await createDebtAs(ownerToken, { amountOriginal: 100 });
    const res = await getHistory(debt.id, ownerToken, "?cursor=not-a-real-cursor");
    expect(res.status).toBe(400);
  });

  it("cross-tenant isolation: a different business gets the same clean 404 as elsewhere in this repo", async () => {
    const debt = await createDebtAs(ownerToken, { amountOriginal: 200 });
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const res = await getHistory(debt.id, otherLogin.accessToken);
    expect(res.status).toBe(404);
  });

  it("RBAC matches the parent debt's own read bar", async () => {
    const debt = await createDebtAs(ownerToken, { amountOriginal: 100 });
    const res = await getHistory(debt.id);
    expect(res.status).toBe(200);
    const unauth = await request(app).get(`/debts/${debt.id}/history`);
    expect(unauth.status).toBe(401);
  });
});
