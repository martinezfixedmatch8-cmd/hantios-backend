import request from "supertest";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { discoverAndSendReminders } from "../src/lib/reminderScheduler";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner } from "./helpers/factories";

describe("Reminder Scheduler (discoverAndSendReminders)", () => {
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

  const idemKey = () => `test-${randomUUID()}`;
  const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  async function createOverdueDebt() {
    const res = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        customerPhone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
        customerName: "Scheduler Test Customer",
        amountOriginal: 1000,
        dateTaken: isoDate(-40),
        dateDue: isoDate(-20), // overdue
      });
    if (res.status !== 201) throw new Error(`create debt failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  it("a single tick sends exactly one reminder for a newly-overdue debt", async () => {
    const debt = await createOverdueDebt();
    await discoverAndSendReminders();

    const reminders = await prisma.debt_reminders.findMany({ where: { debt_id: debt.id } });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].reminder_type).toBe("overdue");
    expect(reminders[0].status).toBe("sent");
  });

  it("sequential idempotency: a second tick after the first is a safe no-op for the same debt+type+business-day", async () => {
    const debt = await createOverdueDebt();

    await discoverAndSendReminders();
    const afterFirst = await prisma.debt_reminders.count({ where: { debt_id: debt.id } });
    expect(afterFirst).toBe(1);

    await discoverAndSendReminders();
    const afterSecond = await prisma.debt_reminders.count({ where: { debt_id: debt.id } });
    expect(afterSecond).toBe(1);
  });

  it("DB-level idempotency under real concurrency: two ticks racing on the same debt still produce exactly one sent reminder", async () => {
    const debt = await createOverdueDebt();

    // Two full discovery ticks fired concurrently -- exercises the exact
    // race the debt_reminders unique constraint (debt_id, reminder_type,
    // business_date) exists to close: both ticks read "no existing reminder"
    // for this debt at roughly the same time, both attempt to claim it, and
    // the DB -- not app-level locking -- must ensure only one send wins.
    await Promise.all([discoverAndSendReminders(), discoverAndSendReminders()]);

    const reminders = await prisma.debt_reminders.findMany({ where: { debt_id: debt.id } });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].status).toBe("sent");
  });

  it("skips a business whose reminder schedule is disabled in Business Settings", async () => {
    const before = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
    await prisma.businesses.update({
      where: { id: businessId },
      data: { settings: { debts: { reminders: { enabled: false } } } as Prisma.InputJsonValue },
    });

    try {
      const debt = await createOverdueDebt();
      await discoverAndSendReminders();
      const reminders = await prisma.debt_reminders.count({ where: { debt_id: debt.id } });
      expect(reminders).toBe(0);
    } finally {
      await prisma.businesses.update({ where: { id: businessId }, data: { settings: (before.settings ?? {}) as Prisma.InputJsonValue } });
    }
  });

  // QA (2026-07-26) -- FOUND BUG, fixed: the eligibility check used to be
  // `isOverdue || (...)`, completely ignoring schedule.overdueDays, so a
  // business configuring a grace period (e.g. "don't nag for 10 days") still
  // got reminded starting the very first day overdue. Fixed by gating the
  // overdue branch on daysPastDue >= schedule.overdueDays, symmetric with how
  // beforeDueDays already gated the other side.
  it("does not send an overdue reminder before the configured overdueDays grace period has elapsed, but does once it has", async () => {
    const before = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
    await prisma.businesses.update({
      where: { id: businessId },
      data: { settings: { debts: { reminders: { enabled: true, beforeDueDays: 3, overdueDays: 10 } } } as Prisma.InputJsonValue },
    });

    try {
      // Overdue by only 3 days -- well short of the configured 10-day grace period.
      const tooSoonRes = await request(app)
        .post("/debts")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({
          customerPhone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
          customerName: "Grace Period Customer",
          amountOriginal: 500,
          dateTaken: isoDate(-30),
          dateDue: isoDate(-3),
        });
      expect(tooSoonRes.status).toBe(201);

      // Overdue by 15 days -- past the 10-day grace period.
      const overdueEnoughRes = await request(app)
        .post("/debts")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({
          customerPhone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
          customerName: "Past Grace Period Customer",
          amountOriginal: 500,
          dateTaken: isoDate(-40),
          dateDue: isoDate(-15),
        });
      expect(overdueEnoughRes.status).toBe(201);

      await discoverAndSendReminders();

      const tooSoonReminders = await prisma.debt_reminders.count({ where: { debt_id: tooSoonRes.body.data.id } });
      expect(tooSoonReminders).toBe(0);

      const overdueEnoughReminders = await prisma.debt_reminders.count({ where: { debt_id: overdueEnoughRes.body.data.id } });
      expect(overdueEnoughReminders).toBe(1);
    } finally {
      await prisma.businesses.update({ where: { id: businessId }, data: { settings: (before.settings ?? {}) as Prisma.InputJsonValue } });
    }
  });
});
