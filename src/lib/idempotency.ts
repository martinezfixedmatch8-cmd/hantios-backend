import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { generateId } from "./ids";
import { conflict } from "./errors";
import { canonicalHash } from "./canonicalJson";

// Idempotency-Key support, first built for Sale creation, reused as-is by
// every module since.
//
// Two-phase because the response body isn't known until the caller's own
// business logic finishes: claim() reserves the (business, actor, key,
// endpoint) slot atomically via the table's own unique constraint (relied
// on here, not re-checked with a prior read) *inside* the caller's
// transaction, so a failed attempt rolls the claim back too and leaves the
// key free for a genuine retry; complete() fills in the real response once
// the transaction has everything it needs, in the same transaction -- no
// post-commit gap where a crash could leave a successful write with no
// idempotency record.
//
// response_status of 0 is a sentinel for "claimed, not yet completed" --
// real HTTP statuses are always >=100, so it can never collide with one.
//
// Batch 8 Session A (HNT-IDEMP-001/002) added: actor_id in the uniqueness
// scope (two different users in the same business can no longer collide on
// an identically-valued client-generated key), a payload_hash (a same-key-
// different-payload retry is rejected, not silently replayed or silently
// allowed to overwrite), and expires_at (a 24h TTL so completed rows don't
// protect/replay forever). All three additions are consistently threaded
// through claimIdempotencyKey / completeIdempotencyKey / getReplayedResponse
// -- every one of this repo's ~84/104 call sites was updated to pass the
// caller's actor id and validated input alongside the existing businessId/
// key/endpoint arguments.

export const IDEMPOTENCY_KEY_TTL_HOURS = 24;

export interface ReplayedResponse {
  status: number;
  body: unknown;
}

// "Genuinely live" -- the one definition shared by getReplayedResponse's
// own expiry check, claimIdempotencyKey's own reclaim guard, and the
// cleanup sweep's own DELETE guard: a row still in-flight
// (response_status===0) is ALWAYS live regardless of expires_at (deleting
// a truly in-flight row out from under a genuinely concurrent request
// risks a duplicate side effect -- the exact race this whole mechanism
// exists to prevent); a completed row is live only while still short of
// its own expires_at.

export async function getReplayedResponse(
  businessId: string,
  actorId: string,
  key: string,
  endpoint: string,
  payload: unknown
): Promise<ReplayedResponse | null> {
  const existing = await prisma.idempotency_keys.findUnique({
    where: { business_id_actor_id_key_endpoint: { business_id: businessId, actor_id: actorId, key, endpoint } },
  });

  if (!existing) return null;

  if (existing.response_status === 0) {
    throw conflict("A request with this Idempotency-Key is already being processed");
  }

  if (existing.expires_at !== null && existing.expires_at < new Date()) {
    // Expired -- treat as if it doesn't exist. The caller's next step
    // (claimIdempotencyKey) will hit its own atomic reclaim path and
    // succeed with a fresh claim.
    return null;
  }

  const freshHash = canonicalHash(payload);
  if (existing.payload_hash !== null && existing.payload_hash !== freshHash) {
    throw conflict("Idempotency-Key was already used with a different request payload");
  }

  return { status: existing.response_status, body: existing.response_body };
}

export async function claimIdempotencyKey(
  tx: Prisma.TransactionClient,
  businessId: string,
  actorId: string,
  key: string,
  endpoint: string,
  payload: unknown
): Promise<void> {
  const payloadHash = canonicalHash(payload);
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_KEY_TTL_HOURS * 3_600_000);
  const id = generateId();

  // Single atomic statement (Batch 8 Session A correction -- a JS-level
  // read-then-delete-then-create sequence left a real window where two
  // concurrent requests could both observe "yes, expired" and race each
  // other). When the WHERE clause evaluates false, Postgres performs no
  // update for that row and RETURNING yields zero rows -- this is one
  // indivisible database operation, not two round trips.
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO idempotency_keys (id, business_id, actor_id, key, endpoint, response_status, response_body, payload_hash, expires_at)
    VALUES (${id}, ${businessId}, ${actorId}, ${key}, ${endpoint}, 0, '{}'::jsonb, ${payloadHash}, ${expiresAt})
    ON CONFLICT (business_id, actor_id, key, endpoint)
    DO UPDATE SET
      id = EXCLUDED.id,
      response_status = 0,
      response_body = '{}'::jsonb,
      payload_hash = EXCLUDED.payload_hash,
      expires_at = EXCLUDED.expires_at
    WHERE idempotency_keys.response_status != 0
      AND idempotency_keys.expires_at IS NOT NULL
      AND idempotency_keys.expires_at < now()
    RETURNING id
  `);

  if (rows.length > 0) return; // claimed -- fresh insert, or a reclaimed-expired row, atomically either way

  // WHERE evaluated false for the existing row -- genuinely live (still
  // in-flight, or completed but not yet expired).
  throw conflict("A request with this Idempotency-Key is already being processed or was already completed");
}

export async function completeIdempotencyKey(
  tx: Prisma.TransactionClient,
  businessId: string,
  actorId: string,
  key: string,
  endpoint: string,
  status: number,
  body: unknown
): Promise<void> {
  await tx.idempotency_keys.update({
    where: { business_id_actor_id_key_endpoint: { business_id: businessId, actor_id: actorId, key, endpoint } },
    data: { response_status: status, response_body: body as Prisma.InputJsonValue },
  });
}

// Batch 8 Session A -- periodic cleanup sweep (run via the new
// scheduled_job_runs mechanism, src/lib/scheduledJob.ts). The
// response_status != 0 guard is deliberate and load-bearing: a stuck
// in-flight claim (one whose original request crashed between claim and
// complete) must NEVER be deleted by a blanket time-based sweep, even if
// its expires_at happens to have elapsed -- that's the same "genuinely
// live" definition claimIdempotencyKey's own reclaim guard uses, applied
// here too, so both paths agree on what's safe to remove. A row stuck at
// response_status=0 forever (a real, narrow, accepted gap -- see
// CLAUDE.md's own Reminder Scheduler precedent for the identical class of
// issue) is left for manual investigation, never silently deleted.
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const result = await prisma.$executeRaw`
    DELETE FROM idempotency_keys
    WHERE expires_at IS NOT NULL AND expires_at < now() AND response_status != 0
  `;
  return result;
}
