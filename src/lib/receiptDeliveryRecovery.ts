import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { prisma } from "./prisma";
import { runScheduledJob } from "./scheduledJob";
import { getNotificationProvider } from "../notifications/registry";
import { requestReceiptDeliveryEndpoint } from "../services/receipt.service";

// Batch 8 Session A (HNT-DELIV-001) -- recovers receipt_delivery_attempts
// rows stuck at "sending" (written atomically in receipt.service.ts's own
// requestReceiptDelivery, immediately before the external I/O call,
// closing the gap where a crash mid-send left a row indistinguishable from
// "never attempted"). A stateless sweep, not a discrete-occurrence job
// like the reminder/payroll schedulers -- every invocation scans the
// FULL currently-stale set regardless of how many prior sweeps were
// missed, so there is no catch-up window to enumerate here (a missed
// 5-minute cycle loses nothing; the next one, whenever it fires, covers
// everything currently stale).
//
// Correction (review pass): a stuck "sending" row is never the only thing
// left dangling -- the SAME request also claimed an idempotency_keys row
// (response_status=0, in-flight) that would otherwise sit unresolved
// forever, since nothing else ever completes it once the process that
// claimed it is gone. Left alone, a same-key retry would hit
// getReplayedResponse's own "already being processed" 409 indefinitely, OR
// -- once that row's own TTL/expiry logic in idempotency.ts eventually
// reclaimed it -- a fresh claim could succeed and fire a SECOND real
// provider send for what might already have gone out once. Recovery now
// atomically resolves BOTH rows together: the attempt becomes "unknown"
// (never "failed" -- that would be a guess) and the paired idempotency key
// is completed with a deterministic 409 "delivery outcome unknown, manual
// review required" body, so a same-key retry replays that 409 -- correctly
// telling the caller "this needs a human, not another automatic attempt"
// -- rather than either hanging on "already being processed" or risking a
// second send.

const JOB_TYPE = "receipt_delivery_recovery";
const MAX_ATTEMPTS = 3;
const STALENESS_MS = 5 * 60_000; // 5 minutes -- see CLAUDE.md's own note: no
// existing provider-timeout config anywhere in this repo to validate this
// against; kept as a still-open, reasonable default until real WhatsApp
// sending exists to calibrate it against.

const DELIVERY_OUTCOME_UNKNOWN_BODY = {
  error: {
    code: "DELIVERY_OUTCOME_UNKNOWN",
    message:
      "This delivery attempt's outcome could not be verified after being stuck in 'sending' past the staleness window. It has been marked for manual review; it will not be retried automatically.",
  },
};

type ReceiptDeliveryAttemptRow = Awaited<ReturnType<typeof prisma.receipt_delivery_attempts.findMany>>[number];

// Atomically resolves both the attempt row and its paired idempotency
// claim (when one can be found and is still genuinely in-flight) in a
// single array-form transaction -- either both update together, or
// neither does. Falls back to updating the attempt alone when there's no
// idempotency_key on the row (attempts created before this column
// existed) or no matching in-flight row is found (already completed by
// some other path, or simply never existed).
async function resolveAttempt(
  attempt: ReceiptDeliveryAttemptRow,
  now: Date,
  attemptData: { status: "success" | "failed" | "unknown"; failure_reason: string | null },
  idempotencyCompletion: { response_status: number; response_body: unknown }
): Promise<void> {
  if (attempt.idempotency_key) {
    const endpoint = requestReceiptDeliveryEndpoint(attempt.receipt_id);
    const idempotencyRow = await prisma.idempotency_keys.findUnique({
      where: {
        business_id_actor_id_key_endpoint: {
          business_id: attempt.business_id,
          actor_id: attempt.requested_by,
          key: attempt.idempotency_key,
          endpoint,
        },
      },
    });

    // Only ever touch a claim that is genuinely still in-flight
    // (response_status===0) -- an already-completed row (e.g. the
    // request actually succeeded and completed normally moments before
    // this sweep ran) must never be overwritten; that would silently
    // destroy a real, correct prior response.
    if (idempotencyRow && idempotencyRow.response_status === 0) {
      await prisma.$transaction([
        prisma.receipt_delivery_attempts.update({
          where: { id: attempt.id },
          data: { ...attemptData, completed_at: now },
        }),
        prisma.idempotency_keys.update({
          where: {
            business_id_actor_id_key_endpoint: {
              business_id: attempt.business_id,
              actor_id: attempt.requested_by,
              key: attempt.idempotency_key,
              endpoint,
            },
          },
          data: { response_status: idempotencyCompletion.response_status, response_body: idempotencyCompletion.response_body as never },
        }),
      ]);
      return;
    }
  }

  // No idempotency_key stored, or no in-flight row found to pair with --
  // resolve the attempt alone (the original, pre-correction behavior).
  await prisma.receipt_delivery_attempts.update({
    where: { id: attempt.id },
    data: { ...attemptData, completed_at: now },
  });
}

export async function recoverStuckDeliveryAttempts(now: Date = new Date()): Promise<{ recovered: number }> {
  const staleBefore = new Date(now.getTime() - STALENESS_MS);
  const stuck = await prisma.receipt_delivery_attempts.findMany({
    where: { status: "sending", requested_at: { lt: staleBefore } },
  });

  const provider = getNotificationProvider();
  let recovered = 0;

  for (const attempt of stuck) {
    // Capability check (mirrors EmailProvider.checkDomainVerification?'s
    // own precedent) -- ConsoleNotificationProvider doesn't implement this,
    // so every stuck row today goes to the "unknown" branch below, never a
    // guessed "failed".
    if (typeof provider.checkDeliveryStatus === "function") {
      const reconciled = await provider.checkDeliveryStatus(attempt.id);
      if (reconciled.status === "delivered") {
        await resolveAttempt(
          attempt,
          now,
          { status: "success", failure_reason: null },
          { response_status: 201, response_body: { data: { ...attempt, status: "success", completed_at: now, failure_reason: null } } }
        );
        recovered++;
        continue;
      }
      if (reconciled.status === "failed") {
        const failureReason = "Reconciled as failed by provider after being stuck in 'sending'";
        await resolveAttempt(
          attempt,
          now,
          { status: "failed", failure_reason: failureReason },
          { response_status: 201, response_body: { data: { ...attempt, status: "failed", completed_at: now, failure_reason: failureReason } } }
        );
        recovered++;
        continue;
      }
      // reconciled.status === "unknown" -- fall through to the same
      // manual-review outcome as the no-capability branch below.
    }

    await resolveAttempt(
      attempt,
      now,
      { status: "unknown", failure_reason: "Stuck in 'sending' past the staleness window; true outcome could not be verified" },
      { response_status: 409, response_body: DELIVERY_OUTCOME_UNKNOWN_BODY }
    );
    recovered++;
  }

  return { recovered };
}

let task: ScheduledTask | null = null;

export function startReceiptDeliveryRecovery(): ScheduledTask {
  if (task) return task;
  task = cron.schedule(
    "*/5 * * * *",
    () => {
      const jobKey = `${JOB_TYPE}:${new Date().toISOString().slice(0, 16)}`; // minute-granular slot
      runScheduledJob(jobKey, JOB_TYPE, MAX_ATTEMPTS, async () => {
        await recoverStuckDeliveryAttempts();
      }).catch((err) => {
        console.error("[receiptDeliveryRecovery] tick failed:", err);
      });
    },
    { noOverlap: true, name: "receipt-delivery-recovery" }
  );
  return task;
}

export function stopReceiptDeliveryRecovery(): void {
  task?.stop();
  task = null;
}
