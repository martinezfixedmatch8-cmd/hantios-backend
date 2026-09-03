import { randomUUID } from "crypto";
import type { Options } from "express-rate-limit";
import { prisma } from "../src/lib/prisma";
import { createPostgresRateLimitStore, cleanupExpiredRateLimitCounters } from "../src/lib/rateLimitStore";

// HNT-OPS-004 (Batch 9 Session A) -- exercises the REAL PostgreSQL store
// directly (no mocking), against the isolated test database, per the
// approved test plan's own explicit requirement.
describe("createPostgresRateLimitStore (HNT-OPS-004)", () => {
  const testKeys: string[] = [];

  afterAll(async () => {
    if (testKeys.length > 0) {
      await prisma.rate_limit_counters.deleteMany({ where: { key: { in: testKeys } } });
    }
    await prisma.$disconnect();
  });

  function newKey(): string {
    const k = `unit-test-${randomUUID()}`;
    testKeys.push(`store-test:${k}`); // matches the "store-test" prefix used below
    return k;
  }

  it("first request creates a counter with count=1 and a correct resetTime", async () => {
    const store = createPostgresRateLimitStore("store-test");
    store.init!({ windowMs: 15_000 } as unknown as Options);
    const key = newKey();
    const before = Date.now();

    const result = await store.increment(key);
    expect(result.totalHits).toBe(1);
    expect(result.resetTime).toBeInstanceOf(Date);
    expect(result.resetTime!.getTime()).toBeGreaterThan(before);
    expect(result.resetTime!.getTime()).toBeLessThanOrEqual(before + 15_000 + 5_000); // generous slack for real Neon latency
  });

  it("repeated requests inside the window increment the same counter without changing resetTime", async () => {
    const store = createPostgresRateLimitStore("store-test");
    store.init!({ windowMs: 60_000 } as unknown as Options);
    const key = newKey();

    const r1 = await store.increment(key);
    const r2 = await store.increment(key);
    const r3 = await store.increment(key);

    expect(r1.totalHits).toBe(1);
    expect(r2.totalHits).toBe(2);
    expect(r3.totalHits).toBe(3);
    expect(r2.resetTime!.getTime()).toBe(r1.resetTime!.getTime());
    expect(r3.resetTime!.getTime()).toBe(r1.resetTime!.getTime());
  });

  it("resets to a fresh window (count=1, new resetTime) once the prior window has expired", async () => {
    const store = createPostgresRateLimitStore("store-test");
    store.init!({ windowMs: 60_000 } as unknown as Options);
    const key = newKey();

    const first = await store.increment(key);
    expect(first.totalHits).toBe(1);

    // Force the row's own reset_at into the past directly -- simulates real
    // expiry without waiting 60s.
    await prisma.rate_limit_counters.update({
      where: { key: `store-test:${key}` },
      data: { reset_at: new Date(Date.now() - 1000) },
    });

    const afterExpiry = await store.increment(key);
    expect(afterExpiry.totalHits).toBe(1); // fresh window, not 2
    expect(afterExpiry.resetTime!.getTime()).toBeGreaterThan(first.resetTime!.getTime());
  });

  it("resetKey() removes the counter entirely -- the next increment starts fresh", async () => {
    const store = createPostgresRateLimitStore("store-test");
    store.init!({ windowMs: 60_000 } as unknown as Options);
    const key = newKey();

    await store.increment(key);
    await store.increment(key);
    await store.resetKey!(key);

    const row = await prisma.rate_limit_counters.findUnique({ where: { key: `store-test:${key}` } });
    expect(row).toBeNull();

    const after = await store.increment(key);
    expect(after.totalHits).toBe(1);
  });

  it("decrement() reduces the counter and never goes negative", async () => {
    const store = createPostgresRateLimitStore("store-test");
    store.init!({ windowMs: 60_000 } as unknown as Options);
    const key = newKey();

    await store.increment(key);
    await store.increment(key);
    await store.decrement!(key);
    let row = await prisma.rate_limit_counters.findUniqueOrThrow({ where: { key: `store-test:${key}` } });
    expect(row.count).toBe(1);

    await store.decrement!(key);
    await store.decrement!(key); // one extra -- must floor at 0, not go negative
    row = await prisma.rate_limit_counters.findUniqueOrThrow({ where: { key: `store-test:${key}` } });
    expect(row.count).toBe(0);
  });

  it("get() returns the current state, and undefined when no counter exists", async () => {
    const store = createPostgresRateLimitStore("store-test");
    store.init!({ windowMs: 60_000 } as unknown as Options);
    const key = newKey();

    expect(await store.get!(key)).toBeUndefined();

    await store.increment(key);
    const info = await store.get!(key);
    expect(info?.totalHits).toBe(1);
    expect(info?.resetTime).toBeInstanceOf(Date);
  });

  it("under genuine concurrency, N simultaneous increments against the SAME key produce exactly N -- no lost updates", async () => {
    const store = createPostgresRateLimitStore("store-test");
    store.init!({ windowMs: 60_000 } as unknown as Options);
    const key = newKey();
    const N = 15;

    const results = await Promise.all(Array.from({ length: N }, () => store.increment(key)));
    const totalHitsSeen = results.map((r) => r.totalHits).sort((a, b) => a - b);
    // Every value 1..N must appear exactly once -- proves no increment was lost.
    expect(totalHitsSeen).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    const row = await prisma.rate_limit_counters.findUniqueOrThrow({ where: { key: `store-test:${key}` } });
    expect(row.count).toBe(N);
  });

  it("cross-instance sharing: two SEPARATE store instances (simulating two API processes) observe the same counter", async () => {
    const instanceA = createPostgresRateLimitStore("store-test");
    const instanceB = createPostgresRateLimitStore("store-test");
    instanceA.init!({ windowMs: 60_000 } as unknown as Options);
    instanceB.init!({ windowMs: 60_000 } as unknown as Options);
    const key = newKey();

    const fromA = await instanceA.increment(key);
    expect(fromA.totalHits).toBe(1);

    const fromB = await instanceB.increment(key);
    expect(fromB.totalHits).toBe(2); // B sees A's own hit -- a shared counter, not two independent ones

    const fromAAgain = await instanceA.increment(key);
    expect(fromAAgain.totalHits).toBe(3); // and A sees B's hit too
  });

  it("different prefixes never collide on the same underlying client key", async () => {
    const storeLogin = createPostgresRateLimitStore("collision-test-login");
    const storeOtp = createPostgresRateLimitStore("collision-test-otp");
    storeLogin.init!({ windowMs: 60_000 } as unknown as Options);
    storeOtp.init!({ windowMs: 60_000 } as unknown as Options);
    const sharedRawKey = `shared-ip-${randomUUID()}`;
    testKeys.push(`collision-test-login:${sharedRawKey}`, `collision-test-otp:${sharedRawKey}`);

    const loginHit = await storeLogin.increment(sharedRawKey);
    const otpHit = await storeOtp.increment(sharedRawKey);

    expect(loginHit.totalHits).toBe(1);
    expect(otpHit.totalHits).toBe(1); // independent -- not 2
  });

  it("cleanupExpiredRateLimitCounters removes only rows expired by more than a day, never an active one", async () => {
    const store = createPostgresRateLimitStore("store-test");
    store.init!({ windowMs: 60_000 } as unknown as Options);
    const staleKey = newKey();
    const activeKey = newKey();

    await store.increment(staleKey);
    await store.increment(activeKey);
    await prisma.rate_limit_counters.update({
      where: { key: `store-test:${staleKey}` },
      data: { reset_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }, // 2 days stale
    });

    await cleanupExpiredRateLimitCounters();

    expect(await prisma.rate_limit_counters.findUnique({ where: { key: `store-test:${staleKey}` } })).toBeNull();
    expect(await prisma.rate_limit_counters.findUnique({ where: { key: `store-test:${activeKey}` } })).not.toBeNull();
  });
});
