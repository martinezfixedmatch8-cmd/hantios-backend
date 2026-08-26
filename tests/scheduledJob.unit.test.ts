import { randomUUID } from "crypto";
import { prisma } from "../src/lib/prisma";
import { ensureJobRow, claimJob, completeJobSuccess, completeJobFailure, runScheduledJob } from "../src/lib/scheduledJob";

describe("Batch 8 Session A (HNT-OPS-001) -- durable job/lease claim", () => {
  const jobTypesUsed = new Set<string>();

  function testJobType(): string {
    const t = `test_job_type_${randomUUID()}`;
    jobTypesUsed.add(t);
    return t;
  }

  afterAll(async () => {
    await prisma.scheduled_job_runs.deleteMany({ where: { job_type: { in: [...jobTypesUsed] } } });
    await prisma.$disconnect();
  });

  it("claims a genuinely pending row", async () => {
    const jobType = testJobType();
    const jobKey = `${jobType}:1`;
    await ensureJobRow(jobKey, jobType, 3);
    const claimed = await claimJob(jobKey);
    expect(claimed).not.toBeNull();
    const row = await prisma.scheduled_job_runs.findUniqueOrThrow({ where: { job_key: jobKey } });
    expect(row.status).toBe("running");
    expect(row.attempts).toBe(1);
  });

  it("ensureJobRow is a safe no-op on a repeated call for the same job_key (a second process/tick/restart)", async () => {
    const jobType = testJobType();
    const jobKey = `${jobType}:1`;
    await ensureJobRow(jobKey, jobType, 3);
    await ensureJobRow(jobKey, jobType, 3); // must not throw, must not create a second row
    const count = await prisma.scheduled_job_runs.count({ where: { job_key: jobKey } });
    expect(count).toBe(1);
  });

  it("HNT-OPS-001 CRITICAL correction: reclaims a job stuck in 'running' after its lease expired -- the corrected predicate, not the buggy original", async () => {
    const jobType = testJobType();
    const jobKey = `${jobType}:1`;
    await ensureJobRow(jobKey, jobType, 3);
    // Force the row into a crashed-mid-run state: status='running', lease
    // already expired. The ORIGINAL buggy design
    // (WHERE status='pending' AND (leased_until IS NULL OR leased_until < now()))
    // would NEVER match this row, since it's not 'pending'.
    await prisma.scheduled_job_runs.updateMany({
      where: { job_key: jobKey },
      data: { status: "running", leased_until: new Date(Date.now() - 1000), attempts: 1 },
    });

    const claimed = await claimJob(jobKey);
    expect(claimed).not.toBeNull(); // the corrected predicate DOES reclaim it
    const row = await prisma.scheduled_job_runs.findUniqueOrThrow({ where: { job_key: jobKey } });
    expect(row.status).toBe("running");
    expect(row.attempts).toBe(2); // incremented on reclaim
  });

  it("does NOT reclaim a 'running' job whose lease has not yet expired", async () => {
    const jobType = testJobType();
    const jobKey = `${jobType}:1`;
    await ensureJobRow(jobKey, jobType, 3);
    await prisma.scheduled_job_runs.updateMany({
      where: { job_key: jobKey },
      data: { status: "running", leased_until: new Date(Date.now() + 5 * 60_000) },
    });

    const claimed = await claimJob(jobKey);
    expect(claimed).toBeNull();
  });

  it("reclaims a 'retry_wait' job once its own backoff has elapsed, not before", async () => {
    const jobType = testJobType();
    const jobKey = `${jobType}:1`;
    await ensureJobRow(jobKey, jobType, 3);

    await prisma.scheduled_job_runs.updateMany({
      where: { job_key: jobKey },
      data: { status: "retry_wait", next_attempt_at: new Date(Date.now() + 60_000) },
    });
    expect(await claimJob(jobKey)).toBeNull(); // not yet due

    await prisma.scheduled_job_runs.updateMany({
      where: { job_key: jobKey },
      data: { next_attempt_at: new Date(Date.now() - 1000) },
    });
    expect(await claimJob(jobKey)).not.toBeNull(); // due now
  });

  it("never reclaims a 'dead_letter' or 'succeeded' row -- both are permanently excluded from the claim predicate", async () => {
    const jobType = testJobType();
    for (const status of ["dead_letter", "succeeded"] as const) {
      const jobKey = `${jobType}:${status}`;
      await ensureJobRow(jobKey, jobType, 3);
      await prisma.scheduled_job_runs.updateMany({ where: { job_key: jobKey }, data: { status, leased_until: new Date(Date.now() - 1000) } });
      expect(await claimJob(jobKey)).toBeNull();
    }
  });

  it("completeJobFailure transitions to retry_wait while attempts < max_attempts, and to dead_letter once exhausted", async () => {
    const jobType = testJobType();
    const jobKey = `${jobType}:1`;
    await ensureJobRow(jobKey, jobType, 2); // max_attempts = 2

    const claimed1 = await claimJob(jobKey); // attempts becomes 1
    await completeJobFailure(claimed1!.id, "transient error");
    let row = await prisma.scheduled_job_runs.findUniqueOrThrow({ where: { job_key: jobKey } });
    expect(row.status).toBe("retry_wait");
    expect(row.next_attempt_at).not.toBeNull();

    await prisma.scheduled_job_runs.updateMany({ where: { job_key: jobKey }, data: { next_attempt_at: new Date(Date.now() - 1000) } });
    const claimed2 = await claimJob(jobKey); // attempts becomes 2 = max_attempts
    await completeJobFailure(claimed2!.id, "still failing");
    row = await prisma.scheduled_job_runs.findUniqueOrThrow({ where: { job_key: jobKey } });
    expect(row.status).toBe("dead_letter");
    expect(row.last_error).toBe("still failing");
  });

  it("runScheduledJob: a claim miss (already running elsewhere) is a silent no-op, never throws", async () => {
    const jobType = testJobType();
    const jobKey = `${jobType}:1`;
    await ensureJobRow(jobKey, jobType, 3);
    await prisma.scheduled_job_runs.updateMany({
      where: { job_key: jobKey },
      data: { status: "running", leased_until: new Date(Date.now() + 5 * 60_000) },
    });

    let ran = false;
    await expect(
      runScheduledJob(jobKey, jobType, 3, async () => {
        ran = true;
      })
    ).resolves.toBeUndefined();
    expect(ran).toBe(false);
  });

  it("runScheduledJob: a successful work() marks the row succeeded", async () => {
    const jobType = testJobType();
    const jobKey = `${jobType}:1`;
    let ran = false;
    await runScheduledJob(jobKey, jobType, 3, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    const row = await prisma.scheduled_job_runs.findUniqueOrThrow({ where: { job_key: jobKey } });
    expect(row.status).toBe("succeeded");
  });

  it("runScheduledJob: a thrown work() is caught and transitions the row to retry_wait, never left stuck at 'running' -- the orphan-invariant this session's own Item-3 proof concerns", async () => {
    const jobType = testJobType();
    const jobKey = `${jobType}:1`;
    await expect(
      runScheduledJob(jobKey, jobType, 3, async () => {
        throw new Error("boom");
      })
    ).resolves.toBeUndefined(); // runScheduledJob itself never re-throws -- it owns failure handling
    const row = await prisma.scheduled_job_runs.findUniqueOrThrow({ where: { job_key: jobKey } });
    expect(row.status).toBe("retry_wait");
    expect(row.last_error).toBe("boom");
  });

  it("completeJobSuccess is directly callable and clears leased_until", async () => {
    const jobType = testJobType();
    const jobKey = `${jobType}:1`;
    await ensureJobRow(jobKey, jobType, 3);
    const claimed = await claimJob(jobKey);
    await completeJobSuccess(claimed!.id);
    const row = await prisma.scheduled_job_runs.findUniqueOrThrow({ where: { job_key: jobKey } });
    expect(row.status).toBe("succeeded");
    expect(row.leased_until).toBeNull();
  });
});
