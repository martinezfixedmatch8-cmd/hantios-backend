import { prisma } from "../src/lib/prisma";
import { generateId } from "../src/lib/ids";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  getReplayedResponse,
  cleanupExpiredIdempotencyKeys,
  IDEMPOTENCY_KEY_TTL_HOURS,
} from "../src/lib/idempotency";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";

describe("Batch 8 Session A -- idempotency: actor scoping, payload-hash, atomic reclaim, cleanup", () => {
  const businessIds: string[] = [];

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  it("HNT-IDEMP-001: two different actors in the same business never collide on an identically-valued key", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const actorA = owner.ownerId;
    const actorB = generateId(); // a distinct, arbitrary second actor identity
    const key = "shared-key-value";
    const endpoint = "POST /test/endpoint";

    // Actor A claims and completes.
    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, actorA, key, endpoint, { from: "A" });
      await completeIdempotencyKey(tx, owner.businessId, actorA, key, endpoint, 201, { data: "A's result" });
    });

    // Actor B, same business, same literal key, same endpoint -- must be
    // completely unaffected by A's own claim; not a 409, not a replay of A's own response.
    const bReplay = await getReplayedResponse(owner.businessId, actorB, key, endpoint, { from: "B" });
    expect(bReplay).toBeNull();

    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, actorB, key, endpoint, { from: "B" });
      await completeIdempotencyKey(tx, owner.businessId, actorB, key, endpoint, 201, { data: "B's result" });
    });

    const aReplay = await getReplayedResponse(owner.businessId, actorA, key, endpoint, { from: "A" });
    const bReplayAfter = await getReplayedResponse(owner.businessId, actorB, key, endpoint, { from: "B" });
    expect((aReplay?.body as { data: string }).data).toBe("A's result");
    expect((bReplayAfter?.body as { data: string }).data).toBe("B's result");
  });

  it("HNT-IDEMP-002: a same-key retry with a different payload is rejected, not silently replayed", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const key = "payload-mismatch-key";
    const endpoint = "POST /test/endpoint2";

    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, { amount: 100 });
      await completeIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, 201, { data: "ok" });
    });

    // Same payload -- a legitimate replay.
    const sameReplay = await getReplayedResponse(owner.businessId, owner.ownerId, key, endpoint, { amount: 100 });
    expect(sameReplay).not.toBeNull();

    // Different payload, same key -- rejected.
    await expect(getReplayedResponse(owner.businessId, owner.ownerId, key, endpoint, { amount: 200 })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("HNT-IDEMP-002: canonical hashing is key-order independent", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const key = "key-order-key";
    const endpoint = "POST /test/endpoint3";

    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, { a: 1, b: 2, nested: { x: 1, y: 2 } });
      await completeIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, 201, { data: "ok" });
    });

    // Same logical payload, different key order throughout -- must replay cleanly, not 409.
    const replay = await getReplayedResponse(owner.businessId, owner.ownerId, key, endpoint, { nested: { y: 2, x: 1 }, b: 2, a: 1 });
    expect(replay).not.toBeNull();
  });

  it("HNT-IDEMP-001: a completed-and-expired row is atomically reclaimed by claimIdempotencyKey itself, not just the cleanup sweep", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const key = "expired-reclaim-key";
    const endpoint = "POST /test/endpoint4";

    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, { v: 1 });
      await completeIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, 201, { data: "first" });
    });

    // Force the row into the past, simulating a legitimately expired key
    // (never done by application code -- only here, to test the reclaim
    // path deterministically without waiting 24h).
    await prisma.idempotency_keys.updateMany({
      where: { business_id: owner.businessId, actor_id: owner.ownerId, key, endpoint },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    // getReplayedResponse treats it as if it doesn't exist.
    const replay = await getReplayedResponse(owner.businessId, owner.ownerId, key, endpoint, { v: 1 });
    expect(replay).toBeNull();

    // A fresh claim succeeds -- the single atomic INSERT...ON CONFLICT...DO
    // UPDATE...WHERE...RETURNING reclaims it, never throwing conflict().
    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, { v: 2 });
      await completeIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, 201, { data: "second" });
    });

    const replayAfter = await getReplayedResponse(owner.businessId, owner.ownerId, key, endpoint, { v: 2 });
    expect((replayAfter?.body as { data: string }).data).toBe("second");
  });

  it("HNT-IDEMP-001: a still in-flight claim (response_status=0) is never reclaimed regardless of expires_at", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const key = "in-flight-key";
    const endpoint = "POST /test/endpoint5";

    // Claim, but never complete (simulates a request that crashed before
    // completing) -- then force expires_at into the past.
    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, { v: 1 });
    });
    await prisma.idempotency_keys.updateMany({
      where: { business_id: owner.businessId, actor_id: owner.ownerId, key, endpoint },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    // getReplayedResponse still throws "already being processed" -- an
    // in-flight row is never treated as expired.
    await expect(getReplayedResponse(owner.businessId, owner.ownerId, key, endpoint, { v: 1 })).rejects.toMatchObject({
      statusCode: 409,
    });

    // A fresh claim attempt is also rejected, not reclaimed.
    await expect(
      prisma.$transaction(async (tx) => {
        await claimIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, { v: 2 });
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    // Confirmed via direct read: the row is untouched (still response_status=0).
    const row = await prisma.idempotency_keys.findUnique({
      where: { business_id_actor_id_key_endpoint: { business_id: owner.businessId, actor_id: owner.ownerId, key, endpoint } },
    });
    expect(row?.response_status).toBe(0);
  });

  it("HNT-IDEMP-002: the cleanup sweep only removes completed-and-expired rows, never an in-flight one", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const completedKey = "cleanup-completed-key";
    const inFlightKey = "cleanup-inflight-key";
    const endpoint = "POST /test/endpoint6";

    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, owner.ownerId, completedKey, endpoint, {});
      await completeIdempotencyKey(tx, owner.businessId, owner.ownerId, completedKey, endpoint, 201, { data: "done" });
    });
    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, owner.ownerId, inFlightKey, endpoint, {});
      // never completed
    });

    // Force both past their expiry.
    await prisma.idempotency_keys.updateMany({
      where: { business_id: owner.businessId, actor_id: owner.ownerId, endpoint, key: { in: [completedKey, inFlightKey] } },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    await cleanupExpiredIdempotencyKeys();

    const completedRow = await prisma.idempotency_keys.findUnique({
      where: { business_id_actor_id_key_endpoint: { business_id: owner.businessId, actor_id: owner.ownerId, key: completedKey, endpoint } },
    });
    const inFlightRow = await prisma.idempotency_keys.findUnique({
      where: { business_id_actor_id_key_endpoint: { business_id: owner.businessId, actor_id: owner.ownerId, key: inFlightKey, endpoint } },
    });

    expect(completedRow).toBeNull(); // deleted
    expect(inFlightRow).not.toBeNull(); // preserved, even though expired -- never safe to auto-delete
    expect(inFlightRow?.response_status).toBe(0);
  });

  it("HNT-IDEMP-001/002 migration: a legacy-shaped row (actor_id='legacy', payload_hash=null, short expires_at) behaves exactly as designed -- no payload protection, reclaimable once past its own expiry", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const endpoint = "POST /test/legacy-endpoint";
    const key = "legacy-simulated-key";

    // Simulates the exact shape the migration's own backfill produces for
    // pre-existing rows: a real users.id was never available historically,
    // so actor_id='legacy'; payload_hash was never computed, so null;
    // expires_at is short (the migration assigns +1h from migration time --
    // here forced already-past to test the reclaim path deterministically).
    await prisma.idempotency_keys.create({
      data: {
        id: generateId(),
        business_id: owner.businessId,
        actor_id: "legacy",
        key,
        endpoint,
        response_status: 201,
        response_body: { data: "pre-migration result" },
        payload_hash: null,
        expires_at: new Date(Date.now() - 1000),
      },
    });

    // No payload protection for a legacy row -- any payload is accepted
    // without a mismatch check, but it's also already past its own expiry,
    // so getReplayedResponse treats it as if it doesn't exist.
    const replay = await getReplayedResponse(owner.businessId, "legacy", key, endpoint, { anything: "goes" });
    expect(replay).toBeNull();

    // A fresh claim under the SAME (business, actor_id='legacy', key,
    // endpoint) tuple succeeds via the atomic reclaim path -- proving the
    // migration's own backfill design (short-expire, don't grandfather
    // forever) actually results in prompt, safe reclaimability.
    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, "legacy", key, endpoint, { fresh: true });
      await completeIdempotencyKey(tx, owner.businessId, "legacy", key, endpoint, 201, { data: "post-migration result" });
    });

    const finalReplay = await getReplayedResponse(owner.businessId, "legacy", key, endpoint, { fresh: true });
    expect((finalReplay?.body as { data: string }).data).toBe("post-migration result");
  });

  it("HNT-IDEMP-002: TTL constant is 24 hours, the confirmed conservative default", () => {
    expect(IDEMPOTENCY_KEY_TTL_HOURS).toBe(24);
  });

  it("HNT-IDEMP-002: a real claim's expires_at is set to roughly now + 24h", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const key = "ttl-check-key";
    const endpoint = "POST /test/ttl-endpoint";

    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, owner.businessId, owner.ownerId, key, endpoint, {});
    });

    const row = await prisma.idempotency_keys.findUniqueOrThrow({
      where: { business_id_actor_id_key_endpoint: { business_id: owner.businessId, actor_id: owner.ownerId, key, endpoint } },
    });
    const expectedMs = Date.now() + 24 * 3_600_000;
    expect(row.expires_at).not.toBeNull();
    expect(Math.abs((row.expires_at as Date).getTime() - expectedMs)).toBeLessThan(60_000); // within a minute of tolerance
  });
});
