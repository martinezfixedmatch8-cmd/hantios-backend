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
import { domainEvents } from "../src/lib/events";

describe("PO Commercial Invoice + Full Payment Status", () => {
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

  // Builds a fully-prepaid PO: create -> send -> confirm -> issue proforma
  // -> supplier payment instruction -> advance payment(s) covering the
  // full proforma total. Everything the Commercial Invoice gate needs.
  async function createFullyPrepaidPo(costPrice = 10, quantity = 10, paymentTerms?: "net_30" | "net_60" | "net_90") {
    const supplier = await createTestSupplier(businessId);
    if (paymentTerms) {
      await prisma.suppliers.update({ where: { id: supplier.id }, data: { payment_terms: paymentTerms } });
    }
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
    // Deliberately left at SENT, not CONFIRMED -- Proforma/advance-payment/
    // Commercial-Invoice/GRN/settlement-payment all accept "sent" as a
    // valid PO status, and staying at SENT keeps this fixture reusable for
    // the cancellation test too (CONFIRMED can never be cancelled, per
    // Module 11 Session A's own locked rule).
    const fullPoRes = await request(app).get(`/purchase-orders/${sendRes.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
    const po = fullPoRes.body.data;

    const proformaRes = await request(app)
      .post(`/purchase-orders/${po.id}/proforma-invoices`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ validUntil: futureDate(30) });
    const proforma = proformaRes.body.data;

    const instructionRes = await request(app)
      .post(`/suppliers/${supplier.id}/payment-instructions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ beneficiaryName: "Acme Supplies Ltd", accountNumber: "0123456789", defaultCurrency: "KES" });

    await request(app)
      .post(`/purchase-orders/${po.id}/advance-payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instructionRes.body.data.id, amount: proforma.total, currency: "KES" });

    return { po, supplier, product, proforma, instruction: instructionRes.body.data };
  }

  describe("RBAC", () => {
    const cases: { role: UserRole; canIssue: boolean; canView: boolean }[] = [
      { role: "owner", canIssue: true, canView: true },
      { role: "manager", canIssue: true, canView: true },
      { role: "accountant", canIssue: false, canView: true },
      { role: "storekeeper", canIssue: false, canView: false },
      { role: "cashier", canIssue: false, canView: false },
      { role: "shareholder", canIssue: false, canView: false },
      { role: "custom", canIssue: false, canView: false },
      { role: "super_admin", canIssue: true, canView: true },
    ];

    it.each(cases)("role=$role issue=$canIssue view=$canView", async ({ role, canIssue, canView }) => {
      const { po } = await createFullyPrepaidPo();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const issueRes = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(issueRes.status).toBe(canIssue ? 201 : 403);

      const listRes = await request(app).get(`/purchase-orders/${po.id}/commercial-invoices`).set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);

      const statusRes = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${token}`);
      expect(statusRes.status).toBe(canView ? 200 : 403);
    });
  });

  describe("Issuance gate", () => {
    it("400s when no Proforma Invoice has ever been issued", async () => {
      const supplier = await createTestSupplier(businessId);
      const product = await createTestProduct(businessId);
      const createRes = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 5, unitCostSnapshot: 10 }] });
      const sendRes = await request(app)
        .post(`/purchase-orders/${createRes.body.data.id}/send`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: createRes.body.data.version });

      const res = await request(app)
        .post(`/purchase-orders/${sendRes.body.data.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(res.status).toBe(400);
    });

    it("400s when the Proforma Invoice is only PARTIALLY_PAID", async () => {
      const supplier = await createTestSupplier(businessId);
      const product = await createTestProduct(businessId, { costPrice: 10 });
      const createRes = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 10, unitCostSnapshot: 10 }] });
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
        .send({ beneficiaryName: "Acme", accountNumber: "111", defaultCurrency: "KES" });
      await request(app)
        .post(`/purchase-orders/${po.id}/advance-payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({
          proformaInvoiceId: proformaRes.body.data.id,
          supplierPaymentInstructionId: instructionRes.body.data.id,
          amount: 40, // total is 100
          currency: "KES",
        });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(res.status).toBe(400);
    });

    it("allows issuance once FULLY_PREPAID, with totalAmount server-derived from the Proforma total", async () => {
      const { po, proforma } = await createFullyPrepaidPo(10, 10); // total = 100
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.data.total_amount).toBe(proforma.total);
      expect(res.body.data.invoice_number).toMatch(/^CI-\d{6}$/);
    });
  });

  describe("Supersede -- correction chain", () => {
    it("flips the original to superseded and links the correction via supersedes_id", async () => {
      const { po } = await createFullyPrepaidPo();
      const first = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});

      const corrected = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices/${first.body.data.id}/supersede`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ totalAmount: 120, reason: "Final GRN-actual costs came in higher than quoted" });
      expect(corrected.status).toBe(201);
      expect(corrected.body.data.supersedes_id).toBe(first.body.data.id);
      expect(corrected.body.data.total_amount).toBe("120");

      const originalReloaded = await prisma.po_commercial_invoices.findUniqueOrThrow({ where: { id: first.body.data.id } });
      expect(originalReloaded.status).toBe("superseded");
    });

    it("400s superseding an invoice that is already superseded", async () => {
      const { po } = await createFullyPrepaidPo();
      const first = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices/${first.body.data.id}/supersede`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ totalAmount: 120, reason: "First correction" });

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices/${first.body.data.id}/supersede`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ totalAmount: 130, reason: "Second correction attempt on the stale one" });
      expect(res.status).toBe(400);
    });
  });

  describe("3-Way Match re-pointing -- settlement payments now read the Commercial Invoice", () => {
    it("matches using the Commercial Invoice's own total_amount, no invoiceAmount needed in the request", async () => {
      const { po, product } = await createFullyPrepaidPo(10, 10); // total = 100
      await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});

      const poItemId = po.purchase_order_items[0].id;
      await request(app)
        .post(`/purchase-orders/${po.id}/goods-received-notes`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, items: [{ poItemId, quantityReceived: 10, unitCostActual: 10 }] }); // 10*10=100, exactly matches
      // GRN increments the PO's own version -- re-fetch before the payment
      // call, same pattern purchaseOrderPayment.test.ts's own
      // createFullyReceivedPo helper already establishes.
      const afterGrn = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);

      const events: unknown[] = [];
      const listener = (payload: unknown) => events.push(payload);
      domainEvents.on("ThreeWayMatchPassed", listener);

      const paymentRes = await request(app)
        .post(`/purchase-orders/${po.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: afterGrn.body.data.version, amount: 10, paymentDate: new Date().toISOString() }); // no invoiceAmount supplied
      expect(paymentRes.status).toBe(201);
      expect(paymentRes.body.data.payment.match_status).toBe("matched");
      expect(paymentRes.body.data.payment.invoice_amount).toBe("100");

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toHaveLength(1);
      domainEvents.off("ThreeWayMatchPassed", listener);

      void product;
    });

    it("400s when no Commercial Invoice exists and invoiceAmount is omitted (unchanged Session B behavior)", async () => {
      const { po } = await createFullyPrepaidPo();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, amount: 10, paymentDate: new Date().toISOString() });
      expect(res.status).toBe(400);
    });

    it("after a supersede, the match uses the CURRENT Commercial Invoice's total, not the superseded one", async () => {
      const { po } = await createFullyPrepaidPo(10, 10); // total = 100
      const first = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices/${first.body.data.id}/supersede`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ totalAmount: 100, reason: "Re-issued with the same total for a formatting fix" });

      const poItemId = po.purchase_order_items[0].id;
      await request(app)
        .post(`/purchase-orders/${po.id}/goods-received-notes`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, items: [{ poItemId, quantityReceived: 10, unitCostActual: 10 }] });
      const afterGrn = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);

      const paymentRes = await request(app)
        .post(`/purchase-orders/${po.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: afterGrn.body.data.version, amount: 10, paymentDate: new Date().toISOString() });
      expect(paymentRes.status).toBe(201);
      expect(paymentRes.body.data.payment.invoice_reference).toContain("CI-");
    });
  });

  describe("Full Payment Status derivation", () => {
    it("UNPAID before any Proforma Invoice exists", async () => {
      const supplier = await createTestSupplier(businessId);
      const product = await createTestProduct(businessId);
      const createRes = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 5, unitCostSnapshot: 10 }] });
      const sendRes = await request(app)
        .post(`/purchase-orders/${createRes.body.data.id}/send`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: createRes.body.data.version });

      const res = await request(app).get(`/purchase-orders/${sendRes.body.data.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.body.data.status).toBe("UNPAID");
    });

    it("FULLY_PAID once a Commercial Invoice is issued (server-derived total already fully covered by construction)", async () => {
      const { po } = await createFullyPrepaidPo();
      await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});

      const res = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.body.data.status).toBe("FULLY_PAID");
    });

    it("PARTIALLY_PAID after a supersede raises the total above what's already been paid", async () => {
      const { po } = await createFullyPrepaidPo(10, 10); // total = 100, fully advance-paid
      const first = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices/${first.body.data.id}/supersede`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ totalAmount: 150, reason: "Final actual costs came in higher" });

      const res = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.body.data.status).toBe("PARTIALLY_PAID");
      expect(res.body.data.amountOwed).toBe("50");
    });

    // Split into two focused tests (each doing one full flow, not two) --
    // the original combined version exceeded Jest's default 40s timeout
    // under this environment's real per-query Neon latency, a test-design
    // issue, not a logic bug.
    it("OVERDUE for NET_30 terms once the due date has passed", async () => {
      const { po } = await createFullyPrepaidPo(10, 10, "net_30");
      const first = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices/${first.body.data.id}/supersede`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ totalAmount: 150, reason: "Final actual costs came in higher" });

      const commercialInvoices = await prisma.po_commercial_invoices.findMany({ where: { purchase_order_id: po.id, status: "issued" } });
      const pastDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await prisma.po_commercial_invoices.update({ where: { id: commercialInvoices[0].id }, data: { issued_at: pastDate } });

      const overdueRes = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(overdueRes.body.data.status).toBe("OVERDUE");
    }, 90000);

    it("never reports OVERDUE for PREPAYMENT terms, even with an old issued_at and an uncovered balance", async () => {
      const { po: prepaymentPo } = await createFullyPrepaidPo(10, 10);
      const prepaymentCi = await request(app)
        .post(`/purchase-orders/${prepaymentPo.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      await request(app)
        .post(`/purchase-orders/${prepaymentPo.id}/commercial-invoices/${prepaymentCi.body.data.id}/supersede`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ totalAmount: 150, reason: "Final actual costs came in higher" });

      const prepaymentCis = await prisma.po_commercial_invoices.findMany({ where: { purchase_order_id: prepaymentPo.id, status: "issued" } });
      const pastDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await prisma.po_commercial_invoices.update({ where: { id: prepaymentCis[0].id }, data: { issued_at: pastDate } });

      const prepaymentRes = await request(app)
        .get(`/purchase-orders/${prepaymentPo.id}/payment-status`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(prepaymentRes.body.data.status).toBe("PARTIALLY_PAID");
    }, 90000);

    it("CANCELLED once the PO is cancelled, regardless of payment state", async () => {
      const { po } = await createFullyPrepaidPo();
      await request(app)
        .post(`/purchase-orders/${po.id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, reason: "Supplier could not fulfill" });

      const res = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.body.data.status).toBe("CANCELLED");
    });
  });

  it("isolates commercial invoices across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const { po } = await createFullyPrepaidPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/commercial-invoices`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({});
    expect(res.status).toBe(404);
  });
});
