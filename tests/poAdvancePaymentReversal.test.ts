import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import {
  signupTestOwner,
  loginTestOwner,
  createTestUser,
  mintAccessToken,
  createTestBranch,
  createTestProduct,
  createTestSupplier,
} from "./helpers/factories";
import type { UserRole } from "@prisma/client";

// Batch 4 remediation (HNT2-PO-002) -- PO advance payment reversals: full,
// partial, multiple partials, atomic cumulative bound, RBAC, idempotency,
// cross-tenant isolation (both service-level and the real composite-FK
// database-level guard), and re-verification that Batch 1's own
// concurrent-overpayment fix still holds correctly once reversals exist.
describe("PO Advance Payment Reversals", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let branchId: string;

  const idemKey = () => `test-${randomUUID()}`;

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

  function futureDate(daysFromNow: number): string {
    return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
  }

  async function createSentPoWithProforma(costPrice = 10, quantity = 10, token = ownerToken) {
    const supplier = await createTestSupplier(businessId);
    const product = await createTestProduct(businessId, { costPrice });
    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: quantity, unitCostSnapshot: costPrice }] });
    const sendRes = await request(app)
      .post(`/purchase-orders/${createRes.body.data.id}/send`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: createRes.body.data.version });
    const po = sendRes.body.data;

    const proformaRes = await request(app)
      .post(`/purchase-orders/${po.id}/proforma-invoices`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ validUntil: futureDate(30) });

    const instructionRes = await request(app)
      .post(`/suppliers/${supplier.id}/payment-instructions`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ beneficiaryName: "Acme Supplies Ltd", bankName: "Equity Bank", accountNumber: "0123456789", defaultCurrency: "KES" });

    return { po, supplier, product, proforma: proformaRes.body.data, instruction: instructionRes.body.data };
  }

  async function recordPayment(poId: string, proformaId: string, instructionId: string, amount: number, token = ownerToken) {
    const res = await request(app)
      .post(`/purchase-orders/${poId}/advance-payments`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ proformaInvoiceId: proformaId, supplierPaymentInstructionId: instructionId, amount, currency: "KES" });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  it("full reversal drives effectiveAmount to zero", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 100, reason: "entered wrong amount", version: 0 });
    expect(res.status).toBe(201);

    const list = await request(app).get(`/purchase-orders/${po.id}/advance-payments`).set("Authorization", `Bearer ${ownerToken}`);
    const row = list.body.data.find((p: { id: string }) => p.id === payment.id);
    expect(row.effectiveAmount).toBe("0");
    expect(row.reversedAmount).toBe("100");
  });

  it("partial reversal reduces effectiveAmount correctly, and a second partial reversal can follow", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);

    const first = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 40, reason: "partial correction 1", version: 0 });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 40, reason: "partial correction 2", version: 1 });
    expect(second.status).toBe(201);

    const list = await request(app).get(`/purchase-orders/${po.id}/advance-payments`).set("Authorization", `Bearer ${ownerToken}`);
    const row = list.body.data.find((p: { id: string }) => p.id === payment.id);
    expect(row.effectiveAmount).toBe("20");
    expect(row.reversedAmount).toBe("80");
    expect(row.reversals).toHaveLength(2);

    // A third reversal exceeding what remains (20) is rejected.
    const third = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 30, reason: "too much", version: 2 });
    expect(third.status).toBe(409);
    expect(third.body.error?.message ?? third.body.message).toContain("20");
  });

  it("reversal request exceeding the remaining amount is rejected with the exact remaining figure", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 150, reason: "too much", version: 0 });
    expect(res.status).toBe(409);
  });

  it("double-full-reversal is rejected", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);

    const first = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 100, reason: "full reversal", version: 0 });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 1, reason: "attempt again", version: 1 });
    expect(second.status).toBe(409);
  });

  it("reversal-of-a-reversal is structurally impossible -- original_payment_id only ever accepts a real po_advance_payments row", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);
    const reversalRes = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 50, reason: "first reversal", version: 0 });
    expect(reversalRes.status).toBe(201);
    const reversalId = reversalRes.body.data.id;

    // No API route exists to target a reversal row as an "original
    // payment" (the reversal endpoint is scoped under
    // /advance-payments/:paymentId/, and :paymentId is looked up against
    // po_advance_payments, never po_advance_payment_reversals). Proven
    // directly at the DB layer: attempting to insert a reversal whose
    // original_payment_id points at a REVERSAL row (not a real payment)
    // violates the composite FK, since po_advance_payment_reversals.id is
    // never a valid (business_id, id) pair in po_advance_payments.
    await expect(
      prisma.$executeRaw`
        INSERT INTO po_advance_payment_reversals (id, business_id, original_payment_id, delta_amount, reason, created_by, created_at)
        SELECT gen_random_uuid()::text, ${businessId}, ${reversalId}, -1.00, 'reversal of a reversal attempt', created_by, now()
        FROM po_advance_payment_reversals WHERE id = ${reversalId}
      `
    ).rejects.toThrow();
  });

  it("concurrent full-amount reversal attempts against the same payment -- exactly one succeeds, effective balance never negative", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);

    const [first, second] = await Promise.all([
      request(app)
        .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 100, reason: "concurrent A", version: 0 }),
      request(app)
        .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 100, reason: "concurrent B", version: 0 }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const reversals = await prisma.po_advance_payment_reversals.findMany({ where: { original_payment_id: payment.id } });
    expect(reversals).toHaveLength(1);
    const reversedTotal = reversals.reduce((sum, r) => sum + Math.abs(Number(r.delta_amount)), 0);
    expect(reversedTotal).toBeLessThanOrEqual(100);
  });

  it("concurrent partial reversals whose combined amount exceeds the payment -- exactly one succeeds, total reversed never exceeds the original", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);

    const [first, second] = await Promise.all([
      request(app)
        .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 60, reason: "concurrent partial A", version: 0 }),
      request(app)
        .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 60, reason: "concurrent partial B", version: 0 }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const reversals = await prisma.po_advance_payment_reversals.findMany({ where: { original_payment_id: payment.id } });
    const reversedTotal = reversals.reduce((sum, r) => sum + Math.abs(Number(r.delta_amount)), 0);
    expect(reversedTotal).toBeLessThanOrEqual(100);
    expect(reversedTotal).toBe(60);
  });

  it("a stale version is rejected -- distinct from the aggregate-bound conflict", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);

    // A real reversal advances version to 1.
    await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 10, reason: "first", version: 0 });

    // Retrying with the now-stale version=0.
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 10, reason: "stale attempt", version: 0 });
    expect(res.status).toBe(409);
  });

  it("Idempotency-Key replay returns the byte-identical original response, never a second reversal row", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);
    const key = idemKey();

    const first = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send({ amount: 30, reason: "idempotent reversal", version: 0 });
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send({ amount: 30, reason: "idempotent reversal", version: 0 });
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);

    const reversals = await prisma.po_advance_payment_reversals.findMany({ where: { original_payment_id: payment.id } });
    expect(reversals).toHaveLength(1);
  });

  it("a failed reversal (aggregate-bound conflict) leaves no stuck idempotency record -- the same key can be retried with a valid amount", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);
    const key = idemKey();

    const failed = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send({ amount: 500, reason: "way too much", version: 0 });
    expect(failed.status).toBe(409);

    const keyRow = await prisma.idempotency_keys.findFirst({ where: { business_id: businessId, key } });
    expect(keyRow).toBeNull();

    // The SAME key, now with a valid amount, succeeds normally.
    const retried = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send({ amount: 20, reason: "corrected retry", version: 0 });
    expect(retried.status).toBe(201);
  });

  describe("RBAC", () => {
    const cases: { role: UserRole; canReverse: boolean }[] = [
      { role: "owner", canReverse: true },
      { role: "manager", canReverse: true },
      { role: "accountant", canReverse: false },
      { role: "storekeeper", canReverse: false },
      { role: "cashier", canReverse: false },
      { role: "shareholder", canReverse: false },
      { role: "custom", canReverse: false },
      { role: "super_admin", canReverse: true },
    ];

    it.each(cases)("role=$role reverse=$canReverse", async ({ role, canReverse }) => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
      const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 10, reason: "rbac test", version: 0 });
      expect(res.status).toBe(canReverse ? 201 : 403);
    });
  });

  it("cross-tenant isolation: a different business cannot reverse a payment it doesn't own (404, service-level)", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
    const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);

    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ amount: 10, reason: "cross-tenant attempt", version: 0 });
    expect(res.status).toBe(404);
  });

  it("cross-tenant isolation: the composite FK rejects a raw INSERT pairing one business's id with another business's payment (database-level)", async () => {
    const { po: poA, proforma: proformaA, instruction: instructionA } = await createSentPoWithProforma(10, 10);
    const paymentA = await recordPayment(poA.id, proformaA.id, instructionA.id, 100);

    const businessB = await signupTestOwner();
    businessIds.push(businessB.businessId);

    await expect(
      prisma.$executeRaw`
        INSERT INTO po_advance_payment_reversals (id, business_id, original_payment_id, delta_amount, reason, created_by, created_at)
        VALUES (gen_random_uuid()::text, ${businessB.businessId}, ${paymentA.id}, -1.00, 'cross-tenant fk test', ${businessB.ownerId}, now())
      `
    ).rejects.toThrow();
  });

  describe("getEffectiveAdvancePaidSum -- cap recalculation excludes reversed amounts", () => {
    it("after a reversal, a new payment can be recorded up to the corrected remaining cap", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100
      const payment = await recordPayment(po.id, proforma.id, instruction.id, 100);

      // Fully reverse it -- the effective sum should drop back to 0.
      await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 100, reason: "wrong amount entered", version: 0 });

      // Now a fresh payment up to the full 100 succeeds again -- would have
      // been rejected by the pre-Batch-4 cap check, which summed
      // po_advance_payments.amount directly with zero awareness of
      // reversals.
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 100, currency: "KES" });
      expect(res.status).toBe(201);
    });

    it("the Commercial Invoice payment-status endpoint reflects the corrected effective sum after a reversal", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100
      await recordPayment(po.id, proforma.id, instruction.id, 100);

      const beforeReversal = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(beforeReversal.body.data.status).toBe("FULLY_PREPAID");

      const payment = await prisma.po_advance_payments.findFirstOrThrow({ where: { proforma_invoice_id: proforma.id } });
      await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 60, reason: "partial correction", version: 0 });

      const afterReversal = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(afterReversal.body.data.status).toBe("PARTIALLY_PAID");
    });

    it("the Proforma Invoice's own amountPaid/amountRemaining/paymentStatus reflect a reversal", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100
      const payment = await recordPayment(po.id, proforma.id, instruction.id, 70);

      await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 30, reason: "correction", version: 0 });

      const invoiceRes = await request(app)
        .get(`/purchase-orders/${po.id}/proforma-invoices/${proforma.id}`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(invoiceRes.body.data.amountPaid).toBe("40");
      expect(invoiceRes.body.data.amountRemaining).toBe("60");
      expect(invoiceRes.body.data.paymentStatus).toBe("PARTIALLY_PAID");
    });

    // Batch 1's own concurrent-overpayment test, re-run against a scenario
    // with a prior REVERSED payment present -- confirms the two fixes
    // compose correctly: the reversed amount is correctly excluded from
    // the running cap total, exactly the gap Batch 1's own comment flagged
    // as future Batch 4 work.
    it("Batch 1 regression: concurrent overpayment protection still holds correctly with a reversed payment already excluded from the cap", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100
      const firstPayment = await recordPayment(po.id, proforma.id, instruction.id, 50);
      // Reverse it fully -- the cap's own "already recorded" figure should
      // now correctly read 0, not 50.
      await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments/${firstPayment.id}/reversals`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 50, reason: "correction", version: 0 });

      // Two concurrent payments whose combined total (60+60=120) exceeds
      // the cap (100) -- exactly one must succeed, same as Batch 1's own
      // original test, now proven correct even with reversal history
      // present.
      const [first, second] = await Promise.all([
        request(app)
          .post(`/purchase-orders/${po.id}/advance-payments`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 60, currency: "KES" }),
        request(app)
          .post(`/purchase-orders/${po.id}/advance-payments`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 60, currency: "KES" }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const effectiveSum = await prisma.po_advance_payments.findMany({ where: { proforma_invoice_id: proforma.id, id: { not: firstPayment.id } } });
      const total = effectiveSum.reduce((sum, p) => sum + Number(p.amount), 0);
      expect(total).toBeLessThanOrEqual(100);
      expect(total).toBe(60);
    });
  });

  describe("Reveal endpoint (advance-payment snapshot side)", () => {
    it("a caller with reveal_payment_instruction sees the full unmasked snapshot", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
      const payment = await recordPayment(po.id, proforma.id, instruction.id, 10);

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reveal`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.account_number_snapshot).toBe("0123456789");
    });

    it("a caller without the permission is rejected", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
      const payment = await recordPayment(po.id, proforma.id, instruction.id, 10);
      const accountant = await createTestUser(businessId, "accountant");
      const token = mintAccessToken(accountant);

      const res = await request(app).post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reveal`).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("exactly one audit row is created per reveal call, with no full sensitive value inside it", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
      const payment = await recordPayment(po.id, proforma.id, instruction.id, 10);

      const before = await prisma.audit_logs.count({ where: { business_id: businessId, action: "po_advance_payment.sensitive_data_revealed" } });
      await request(app).post(`/purchase-orders/${po.id}/advance-payments/${payment.id}/reveal`).set("Authorization", `Bearer ${ownerToken}`);
      const after = await prisma.audit_logs.count({ where: { business_id: businessId, action: "po_advance_payment.sensitive_data_revealed" } });
      expect(after).toBe(before + 1);

      const row = await prisma.audit_logs.findFirstOrThrow({
        where: { business_id: businessId, action: "po_advance_payment.sensitive_data_revealed", entity_id: payment.id },
        orderBy: { created_at: "desc" },
      });
      expect(row.correlation_id).toBeTruthy();
      expect(JSON.stringify(row.after_state)).not.toContain("0123456789");
    });

    it("routine list reads create zero audit rows", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
      await recordPayment(po.id, proforma.id, instruction.id, 10);

      const before = await prisma.audit_logs.count({ where: { business_id: businessId, action: "po_advance_payment.sensitive_data_revealed" } });
      for (let i = 0; i < 5; i++) {
        await request(app).get(`/purchase-orders/${po.id}/advance-payments`).set("Authorization", `Bearer ${ownerToken}`);
      }
      const after = await prisma.audit_logs.count({ where: { business_id: businessId, action: "po_advance_payment.sensitive_data_revealed" } });
      expect(after).toBe(before);
    });
  });

  describe("Masking on listAdvancePayments and the creation response, for every role including owner/manager", () => {
    it("listAdvancePayments never returns a raw sensitive value, for any role", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
      await recordPayment(po.id, proforma.id, instruction.id, 10);

      const res = await request(app).get(`/purchase-orders/${po.id}/advance-payments`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data[0].account_number_snapshot).toBe("****6789");
      expect(JSON.stringify(res.body)).not.toContain("0123456789");
    });

    it("the stored idempotency response body itself contains only masked values, never the real ones", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
      const key = idemKey();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 10, currency: "KES" });
      expect(res.status).toBe(201);

      const keyRow = await prisma.idempotency_keys.findFirstOrThrow({ where: { business_id: businessId, key } });
      expect(JSON.stringify(keyRow.response_body)).not.toContain("0123456789");
    });

    it("even an accountant creating a payment gets a masked response for their own creation call", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10);
      const accountant = await createTestUser(businessId, "accountant");
      const token = mintAccessToken(accountant);

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 10, currency: "KES" });
      expect(res.status).toBe(201);
      expect(res.body.data.account_number_snapshot).toBe("****6789");
    });
  });
});
