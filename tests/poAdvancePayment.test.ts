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
  createTestPaymentMethod,
} from "./helpers/factories";
import type { UserRole } from "@prisma/client";

describe("PO Advance Payments", () => {
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

  async function createSentPoWithProforma(costPrice = 10, quantity = 10) {
    const supplier = await createTestSupplier(businessId);
    const product = await createTestProduct(businessId, { costPrice });
    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: quantity, unitCostSnapshot: costPrice }] });
    const sendRes = await request(app)
      .post(`/purchase-orders/${createRes.body.data.id}/send`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: createRes.body.data.version });
    const po = sendRes.body.data;

    const proformaRes = await request(app)
      .post(`/purchase-orders/${po.id}/proforma-invoices`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ validUntil: futureDate(30) });

    const instructionRes = await request(app)
      .post(`/suppliers/${supplier.id}/payment-instructions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ beneficiaryName: "Acme Supplies Ltd", bankName: "Equity Bank", accountNumber: "0123456789", defaultCurrency: "KES" });

    return { po, supplier, product, proforma: proformaRes.body.data, instruction: instructionRes.body.data };
  }

  describe("RBAC", () => {
    const cases: { role: UserRole; canRecord: boolean; canView: boolean }[] = [
      { role: "owner", canRecord: true, canView: true },
      { role: "manager", canRecord: true, canView: true },
      { role: "accountant", canRecord: true, canView: true },
      { role: "storekeeper", canRecord: false, canView: false },
      { role: "cashier", canRecord: false, canView: false },
      { role: "shareholder", canRecord: false, canView: false },
      { role: "custom", canRecord: false, canView: false },
      { role: "super_admin", canRecord: true, canView: true },
    ];

    it.each(cases)("role=$role record=$canRecord view=$canView", async ({ role, canRecord, canView }) => {
      const { po, proforma, instruction } = await createSentPoWithProforma();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const recordRes = await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 10, currency: "KES" });
      expect(recordRes.status).toBe(canRecord ? 201 : 403);

      const listRes = await request(app).get(`/purchase-orders/${po.id}/advance-payments`).set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);
    });
  });

  describe("Core correctness: full flow, N-installment accumulation, zero Expense creation", () => {
    it("accumulates 3 separate installments to full coverage, flips status to FULLY_PREPAID, and creates ZERO Expense records anywhere in the flow", async () => {
      const expensesBefore = await prisma.expenses.count({ where: { business_id: businessId } });

      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100

      const installments = [
        { amount: 20, label: "Deposit 20%" },
        { amount: 50, label: "Second installment" },
        { amount: 30, label: "Final installment" },
      ];

      for (const installment of installments) {
        const res = await request(app)
          .post(`/purchase-orders/${po.id}/advance-payments`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({
            proformaInvoiceId: proforma.id,
            supplierPaymentInstructionId: instruction.id,
            amount: installment.amount,
            currency: "KES",
            installmentLabel: installment.label,
          });
        expect(res.status).toBe(201);
        expect(res.body.data.installment_label).toBe(installment.label);
      }

      const invoiceRes = await request(app)
        .get(`/purchase-orders/${po.id}/proforma-invoices/${proforma.id}`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(invoiceRes.body.data.paymentStatus).toBe("FULLY_PREPAID");
      expect(invoiceRes.body.data.amountPaid).toBe("100");
      expect(invoiceRes.body.data.amountRemaining).toBe("0");

      const listRes = await request(app).get(`/purchase-orders/${po.id}/advance-payments`).set("Authorization", `Bearer ${ownerToken}`);
      expect(listRes.body.data).toHaveLength(3);

      // THE core accounting-correctness assertion this session exists for.
      const expensesAfter = await prisma.expenses.count({ where: { business_id: businessId } });
      expect(expensesAfter).toBe(expensesBefore);
    });

    it("PARTIALLY_PAID after a partial installment", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100
      await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 40, currency: "KES" });

      const invoiceRes = await request(app)
        .get(`/purchase-orders/${po.id}/proforma-invoices/${proforma.id}`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(invoiceRes.body.data.paymentStatus).toBe("PARTIALLY_PAID");
    });
  });

  describe("Overpayment rejection", () => {
    // HNT2-PO-001 fix -- the cap check now runs INSIDE the transaction,
    // under a row lock on the Proforma Invoice, so a rejected overpayment
    // is a genuine state conflict (what's actually still available on the
    // invoice, re-checked under lock) rather than a static request-shape
    // validation error -- 409, not 400. Deliberate, audit-mandated change
    // from this test's own original 400 expectation.
    it("rejects a single payment exceeding the invoice total (409, a state conflict under lock)", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 150, currency: "KES" });
      expect(res.status).toBe(409);
    });

    it("rejects an installment that would push the cumulative total over the invoice total (409)", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100
      await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 80, currency: "KES" });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 30, currency: "KES" });
      expect(res.status).toBe(409);
    });

    // HNT2-PO-001's own required test: a genuine concurrent integration
    // test against real Postgres/Neon concurrency, not mocked Prisma --
    // two simultaneous requests whose COMBINED total exceeds the cap must
    // result in exactly one success, never both landing (the pre-fix bug)
    // and never the invoice's own true paid total exceeding its cap.
    it("under genuine concurrency, two simultaneous payments whose combined total exceeds the cap -- exactly one succeeds", async () => {
      const { po, proforma, instruction } = await createSentPoWithProforma(10, 10); // total = 100

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

      // The real, authoritative proof: the invoice's own true recorded
      // total, read fresh from the database, never exceeds its cap --
      // not just that one HTTP response happened to say 409.
      const payments = await prisma.po_advance_payments.findMany({ where: { proforma_invoice_id: proforma.id } });
      expect(payments).toHaveLength(1);
      const total = payments.reduce((sum, p) => sum + Number(p.amount), 0);
      expect(total).toBeLessThanOrEqual(100);
      expect(total).toBe(60);
    });
  });

  it("snapshots the payment instruction's details at write time -- a later edit to the instruction does not change historical advance payments", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma();
    const recordRes = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 10, currency: "KES" });
    expect(recordRes.body.data.beneficiary_name_snapshot).toBe("Acme Supplies Ltd");
    expect(recordRes.body.data.account_number_snapshot).toBe("0123456789");

    // Directly mutate the live instruction (simulating a later bank-details
    // change) -- the already-recorded advance payment's own snapshot fields
    // must remain untouched.
    await prisma.supplier_payment_instructions.update({
      where: { id: instruction.id },
      data: { beneficiary_name: "Renamed Beneficiary", account_number: "9999999999" },
    });

    const reloaded = await prisma.po_advance_payments.findUniqueOrThrow({ where: { id: recordRes.body.data.id } });
    expect(reloaded.beneficiary_name_snapshot).toBe("Acme Supplies Ltd");
    expect(reloaded.account_number_snapshot).toBe("0123456789");
  });

  it("rejects a payment instruction that belongs to a different supplier", async () => {
    const { po, proforma } = await createSentPoWithProforma();
    const otherSupplier = await createTestSupplier(businessId);
    const otherInstructionRes = await request(app)
      .post(`/suppliers/${otherSupplier.id}/payment-instructions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ beneficiaryName: "Other Supplier Ltd", accountNumber: "111", defaultCurrency: "KES" });

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: otherInstructionRes.body.data.id, amount: 10, currency: "KES" });
    expect(res.status).toBe(400);
  });

  it("rejects recording a payment against a superseded proforma invoice", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma();
    await request(app)
      .post(`/purchase-orders/${po.id}/proforma-invoices`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ validUntil: futureDate(60) }); // supersedes the first

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 10, currency: "KES" });
    expect(res.status).toBe(400);
  });

  it("accepts an optional paymentMethodId reusing the existing payment_methods table", async () => {
    const { po, proforma, instruction } = await createSentPoWithProforma();
    const method = await createTestPaymentMethod(businessId);

    const res = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 10, currency: "KES", paymentMethodId: method.id });
    expect(res.status).toBe(201);
    expect(res.body.data.payment_method_id).toBe(method.id);
  });

  it("isolates advance payments across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po, proforma, instruction } = await createSentPoWithProforma();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instruction.id, amount: 10, currency: "KES" });
    expect(res.status).toBe(404);
  });
});
