import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { generateId } from "../src/lib/ids";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestBranch, createTestPaymentMethod, createTestProduct } from "./helpers/factories";
import { requestReceiptDeliveryEndpoint } from "../src/services/receipt.service";
import { getReplayedResponse, claimIdempotencyKey } from "../src/lib/idempotency";
import { recoverStuckDeliveryAttempts } from "../src/lib/receiptDeliveryRecovery";

const idemKey = () => `test-${randomUUID()}`;

describe("Batch 8 Session A (HNT-DELIV-001 correction) -- receipt delivery recovery, atomic idempotency-key completion", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let ownerId: string;
  let branchId: string;
  let paymentMethodId: string;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    ownerId = owner.ownerId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;
    const branch = await createTestBranch(businessId);
    branchId = branch.id;
    const pm = await createTestPaymentMethod(businessId);
    paymentMethodId = pm.id;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  async function createRealReceipt() {
    const product = await createTestProduct(businessId, { sellingPrice: 50, costPrice: 20 });
    await prisma.branch_inventory.create({
      data: { id: generateId(), business_id: businessId, branch_id: branchId, product_id: product.id, size: "", quantity: 100 },
    });
    const saleRes = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, paymentMethodId, items: [{ productId: product.id, quantity: 1 }] });
    expect(saleRes.status).toBe(201);
    const receipt = await prisma.receipts.findFirstOrThrow({ where: { sale_id: saleRes.body.data.id } });
    return receipt;
  }

  // Simulates the exact crash scenario: a real claim already committed
  // (response_status=0, still in-flight) and a real receipt_delivery_attempts
  // row already written to "sending", both aged past the staleness window --
  // exactly what a process crash between the "sending" write and the
  // external send completing would leave behind.
  async function simulateStuckSending(receiptId: string, phone = "+254700000111") {
    const key = idemKey();
    const endpoint = requestReceiptDeliveryEndpoint(receiptId);
    const input = { channel: "whatsapp" as const };

    await prisma.$transaction(async (tx) => {
      await claimIdempotencyKey(tx, businessId, ownerId, key, endpoint, input);
    });

    const staleRequestedAt = new Date(Date.now() - 10 * 60_000); // 10 minutes ago, past the 5-minute staleness window
    const attempt = await prisma.receipt_delivery_attempts.create({
      data: {
        id: generateId(),
        business_id: businessId,
        receipt_id: receiptId,
        attempt_number: 1,
        channel: "whatsapp",
        status: "sending",
        requested_at: staleRequestedAt,
        requested_by: ownerId,
        idempotency_key: key,
        phone_snapshot: phone,
      },
    });

    return { attempt, key, endpoint, input };
  }

  it("recovers a stuck 'sending' attempt to 'unknown' AND atomically completes its paired in-flight idempotency key with a deterministic 409", async () => {
    const receipt = await createRealReceipt();
    const { attempt, key, endpoint } = await simulateStuckSending(receipt.id);

    // Confirmed genuinely in-flight before recovery.
    const beforeIdem = await prisma.idempotency_keys.findUniqueOrThrow({
      where: { business_id_actor_id_key_endpoint: { business_id: businessId, actor_id: ownerId, key, endpoint } },
    });
    expect(beforeIdem.response_status).toBe(0);

    const result = await recoverStuckDeliveryAttempts();
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const updatedAttempt = await prisma.receipt_delivery_attempts.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(updatedAttempt.status).toBe("unknown");
    expect(updatedAttempt.completed_at).not.toBeNull();

    const updatedIdem = await prisma.idempotency_keys.findUniqueOrThrow({
      where: { business_id_actor_id_key_endpoint: { business_id: businessId, actor_id: ownerId, key, endpoint } },
    });
    expect(updatedIdem.response_status).toBe(409);
    const body = updatedIdem.response_body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("DELIVERY_OUTCOME_UNKNOWN");
    expect(body.error.message).toMatch(/manual review/i);
  });

  it("a same-key retry after recovery replays the deterministic 409 -- never a second provider send", async () => {
    const receipt = await createRealReceipt();
    const { key, endpoint, input } = await simulateStuckSending(receipt.id);

    await recoverStuckDeliveryAttempts();

    // getReplayedResponse is the exact function every controller calls
    // before ever reaching requestReceiptDelivery -- if this returns the
    // stored 409 without throwing, the caller returns it directly and
    // requestReceiptDelivery (and therefore any provider .send() call) is
    // never invoked a second time for this key.
    const replayed = await getReplayedResponse(businessId, ownerId, key, endpoint, input);
    expect(replayed).not.toBeNull();
    expect(replayed!.status).toBe(409);
    const body = replayed!.body as { error: { code: string } };
    expect(body.error.code).toBe("DELIVERY_OUTCOME_UNKNOWN");
  });

  it("does not touch an idempotency key that has already been completed (e.g. a genuinely successful send that finished moments before the sweep ran)", async () => {
    const receipt = await createRealReceipt();
    const { attempt, key, endpoint } = await simulateStuckSending(receipt.id);

    // Simulate the real completion racing in just before the sweep --
    // response_status is no longer 0.
    await prisma.idempotency_keys.update({
      where: { business_id_actor_id_key_endpoint: { business_id: businessId, actor_id: ownerId, key, endpoint } },
      data: { response_status: 201, response_body: { data: { real: "already completed successfully" } } },
    });
    // The attempt row itself is still (unrealistically, for this isolated
    // test) at "sending" -- but recovery must see the idempotency row is
    // no longer in-flight and must NOT overwrite its real, already-stored
    // response.
    const result = await recoverStuckDeliveryAttempts();
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const idemAfter = await prisma.idempotency_keys.findUniqueOrThrow({
      where: { business_id_actor_id_key_endpoint: { business_id: businessId, actor_id: ownerId, key, endpoint } },
    });
    expect(idemAfter.response_status).toBe(201); // untouched
    const body = idemAfter.response_body as { data: { real: string } };
    expect(body.data.real).toBe("already completed successfully"); // untouched

    // The attempt row itself still gets resolved to "unknown" (attempt-only
    // fallback path), since its own paired idempotency row is no longer a
    // safe target to overwrite.
    const attemptAfter = await prisma.receipt_delivery_attempts.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(attemptAfter.status).toBe("unknown");
  });

  it("falls back to attempt-only recovery when no idempotency_key was stored on the row (pre-existing/legacy attempts)", async () => {
    const receipt = await createRealReceipt();
    const staleRequestedAt = new Date(Date.now() - 10 * 60_000);
    const attempt = await prisma.receipt_delivery_attempts.create({
      data: {
        id: generateId(),
        business_id: businessId,
        receipt_id: receipt.id,
        attempt_number: 1,
        channel: "whatsapp",
        status: "sending",
        requested_at: staleRequestedAt,
        requested_by: ownerId,
        idempotency_key: null,
        phone_snapshot: "+254700000222",
      },
    });

    await expect(recoverStuckDeliveryAttempts()).resolves.toMatchObject({ recovered: expect.any(Number) });
    const updated = await prisma.receipt_delivery_attempts.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(updated.status).toBe("unknown");
  });

  it("does not touch a 'sending' attempt that is not yet past the staleness window", async () => {
    const receipt = await createRealReceipt();
    const attempt = await prisma.receipt_delivery_attempts.create({
      data: {
        id: generateId(),
        business_id: businessId,
        receipt_id: receipt.id,
        attempt_number: 1,
        channel: "whatsapp",
        status: "sending",
        requested_at: new Date(), // just now -- not stale
        requested_by: ownerId,
        idempotency_key: idemKey(),
        phone_snapshot: "+254700000333",
      },
    });

    await recoverStuckDeliveryAttempts();
    const unchanged = await prisma.receipt_delivery_attempts.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(unchanged.status).toBe("sending");
  });
});
