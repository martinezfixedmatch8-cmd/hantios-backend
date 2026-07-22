import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { generateId } from "./ids";
import { conflict } from "./errors";

// Idempotency-Key support, first built for Sale creation, reused as-is by
// Debts' payment endpoint (and Void/Refund) once those sessions land.
//
// Two-phase because the response body isn't known until the caller's own
// business logic finishes: claim() reserves the (business, key, endpoint)
// slot atomically via the table's own unique constraint (relied on here,
// not re-checked with a prior read) *inside* the caller's transaction, so a
// failed attempt rolls the claim back too and leaves the key free for a
// genuine retry; complete() fills in the real response once the transaction
// has everything it needs, in the same transaction -- no post-commit gap
// where a crash could leave a successful write with no idempotency record.
//
// response_status of 0 is a sentinel for "claimed, not yet completed" --
// real HTTP statuses are always >=100, so it can never collide with one.

export interface ReplayedResponse {
  status: number;
  body: unknown;
}

export async function getReplayedResponse(
  businessId: string,
  key: string,
  endpoint: string
): Promise<ReplayedResponse | null> {
  const existing = await prisma.idempotency_keys.findUnique({
    where: { business_id_key_endpoint: { business_id: businessId, key, endpoint } },
  });

  if (!existing) return null;
  if (existing.response_status === 0) {
    throw conflict("A request with this Idempotency-Key is already being processed");
  }
  return { status: existing.response_status, body: existing.response_body };
}

export async function claimIdempotencyKey(
  tx: Prisma.TransactionClient,
  businessId: string,
  key: string,
  endpoint: string
): Promise<void> {
  try {
    await tx.idempotency_keys.create({
      data: {
        id: generateId(),
        business_id: businessId,
        key,
        endpoint,
        response_status: 0,
        response_body: {},
      },
    });
  } catch (err) {
    const isUniqueViolation =
      err instanceof Object && "code" in err && (err as { code?: string }).code === "P2002";
    if (isUniqueViolation) {
      throw conflict("A request with this Idempotency-Key is already being processed or was already completed");
    }
    throw err;
  }
}

export async function completeIdempotencyKey(
  tx: Prisma.TransactionClient,
  businessId: string,
  key: string,
  endpoint: string,
  status: number,
  body: unknown
): Promise<void> {
  await tx.idempotency_keys.update({
    where: { business_id_key_endpoint: { business_id: businessId, key, endpoint } },
    data: { response_status: status, response_body: body as Prisma.InputJsonValue },
  });
}
