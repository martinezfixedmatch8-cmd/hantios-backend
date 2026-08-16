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

// Module 11 Session 3 -- GATE CORRECTION (LOCKED). Session 2B's interim
// FULLY_PREPAID gate is REPLACED, not merely extended: Commercial Invoice
// issuance now depends entirely on shipment status (at least one shipment
// dispatched/in_transit/arrived/delivered), completely decoupled from
// payment collection. Every test below that used to build a "fully
// prepaid" fixture to satisfy the OLD gate now builds a "shipped" fixture
// instead -- a deliberate, intentional behavior change, not a regression.
// Session 2B's own historical write-up (issuance always == the Proforma
// total, so a normal path was guaranteed FULLY_PAID) still holds --
// only the GATE's basis changed, not the total_amount-sourcing logic.
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

  // A plain sent (not confirmed) PO -- deliberately left at SENT so
  // Proforma/advance-payment/Commercial-Invoice/GRN/settlement-payment/
  // Shipments/cancellation all stay valid against it (CONFIRMED can never
  // be cancelled, per Module 11 Session A's own locked rule).
  async function createSentPo(costPrice = 10, quantity = 10, paymentTerms?: "net_30" | "net_60" | "net_90") {
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
    const fullPoRes = await request(app).get(`/purchase-orders/${sendRes.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
    return { po: fullPoRes.body.data, supplier, product };
  }

  // THE new gate's own fixture -- a PO with a shipment at the given status
  // (dispatched by default), no proforma/advance-payment involved at all.
  // This is the fixture the locked regression test (NET_30 + UNPAID can
  // still get a Commercial Invoice once shipped) is built from.
  async function createShippedPo(
    costPrice = 10,
    quantity = 10,
    paymentTerms?: "net_30" | "net_60" | "net_90",
    shipmentStatus: "dispatched" | "in_transit" | "arrived" | "delivered" | "pending" = "dispatched"
  ) {
    const { po, supplier, product } = await createSentPo(costPrice, quantity, paymentTerms);
    const poItemId = po.purchase_order_items[0].id;

    const shipmentRes = await request(app)
      .post(`/purchase-orders/${po.id}/shipments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ method: "sea", items: [{ poItemId, quantityShipped: quantity }] });
    let shipment = shipmentRes.body.data;

    // The shipment status machine is permissive but not unlimited -- it
    // must be walked through the proper forward chain, not jumped to
    // directly (e.g. pending -> in_transit is an invalid skip). Walk every
    // intermediate step up to (and including) the target.
    const FORWARD_CHAIN = ["dispatched", "in_transit", "arrived", "delivered"] as const;
    const targetIndex = FORWARD_CHAIN.indexOf(shipmentStatus as (typeof FORWARD_CHAIN)[number]);
    if (targetIndex !== -1) {
      for (let i = 0; i <= targetIndex; i++) {
        const statusRes = await request(app)
          .patch(`/purchase-orders/${po.id}/shipments/${shipment.id}/status`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: shipment.version, status: FORWARD_CHAIN[i] });
        shipment = statusRes.body.data;
      }
    }

    return { po, supplier, product, shipment };
  }

  // Adds a fully-advance-paid Proforma Invoice on top of a shipped PO --
  // used only where a test needs FULLY_PAID Payment Status specifically,
  // not the issuance gate itself (which no longer cares about payment).
  async function payProformaInFull(poId: string, supplierId: string) {
    const proformaRes = await request(app)
      .post(`/purchase-orders/${poId}/proforma-invoices`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ validUntil: futureDate(30) });
    const proforma = proformaRes.body.data;

    const instructionRes = await request(app)
      .post(`/suppliers/${supplierId}/payment-instructions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ beneficiaryName: "Acme Supplies Ltd", accountNumber: "0123456789", defaultCurrency: "KES" });

    await request(app)
      .post(`/purchase-orders/${poId}/advance-payments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ proformaInvoiceId: proforma.id, supplierPaymentInstructionId: instructionRes.body.data.id, amount: proforma.total, currency: "KES" });

    return proforma;
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
      const { po } = await createShippedPo();
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

  describe("Issuance gate -- shipment status, decoupled from payment (Session 3 correction)", () => {
    it("400s when no shipment has ever been created for the PO", async () => {
      const { po } = await createSentPo();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(res.status).toBe(400);
    });

    it("400s while the only shipment is still PENDING (not yet dispatched)", async () => {
      const { po } = await createShippedPo(10, 10, undefined, "pending");
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(res.status).toBe(400);
    });

    it("201s once the shipment reaches DISPATCHED, with totalAmount server-derived from the PO's own total_expected_value (no Proforma exists)", async () => {
      const { po } = await createShippedPo(10, 10); // 10*10 = 100
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.data.total_amount).toBe("100");
      expect(res.body.data.invoice_number).toMatch(/^CI-\d{6}$/);
    });

    // THE explicit locked regression test: the exact scenario the OLD
    // FULLY_PREPAID gate would have wrongly blocked.
    it("LOCKED REGRESSION: a NET_30 PO with UNPAID Payment Status CAN still get a Commercial Invoice issued once shipped", async () => {
      const { po } = await createShippedPo(10, 10, "net_30");

      const statusBefore = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(statusBefore.body.data.status).toBe("UNPAID");

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(res.status).toBe(201);
    });

    // Confirms the OLD FULLY_PREPAID-only path is truly gone, not left as
    // an alternate/OR condition alongside the new shipment check.
    it("a fully-prepaid-but-NOT-yet-shipped PO CANNOT issue a Commercial Invoice", async () => {
      const { po, supplier } = await createSentPo(10, 10);
      const proforma = await payProformaInFull(po.id, supplier.id);

      const statusRes = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(statusRes.body.data.status).toBe("FULLY_PREPAID");
      void proforma;

      const res = await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(res.status).toBe(400);
    });

    it("201s once the shipment reaches IN_TRANSIT/ARRIVED/DELIVERED too, not only DISPATCHED", async () => {
      for (const status of ["in_transit", "arrived", "delivered"] as const) {
        const { po } = await createShippedPo(10, 10, undefined, status);
        const res = await request(app)
          .post(`/purchase-orders/${po.id}/commercial-invoices`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({});
        expect(res.status).toBe(201);
      }
    }, 90000);
  });

  describe("Supersede -- correction chain", () => {
    it("flips the original to superseded and links the correction via supersedes_id", async () => {
      const { po } = await createShippedPo();
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
      const { po } = await createShippedPo();
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
      const { po } = await createShippedPo(10, 10); // total = 100
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
    }, 90000);

    it("400s when no Commercial Invoice exists and invoiceAmount is omitted (unchanged Session B behavior)", async () => {
      const { po } = await createShippedPo();
      const res = await request(app)
        .post(`/purchase-orders/${po.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version, amount: 10, paymentDate: new Date().toISOString() });
      expect(res.status).toBe(400);
    });

    it("after a supersede, the match uses the CURRENT Commercial Invoice's total, not the superseded one", async () => {
      const { po } = await createShippedPo(10, 10); // total = 100
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

      // HNT-PO-001 fix -- the supersede above now advances the PO's own
      // version (it never did before), so the GRN call must use the
      // CURRENT version, not the one captured before the supersede.
      const poAfterSupersede = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);
      const poItemId = po.purchase_order_items[0].id;
      const grnRes = await request(app)
        .post(`/purchase-orders/${po.id}/goods-received-notes`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: poAfterSupersede.body.data.version, items: [{ poItemId, quantityReceived: 10, unitCostActual: 10 }] });
      expect(grnRes.status).toBe(201);
      const afterGrn = await request(app).get(`/purchase-orders/${po.id}`).set("Authorization", `Bearer ${ownerToken}`);

      const paymentRes = await request(app)
        .post(`/purchase-orders/${po.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: afterGrn.body.data.version, amount: 10, paymentDate: new Date().toISOString() });
      expect(paymentRes.status).toBe(201);
      expect(paymentRes.body.data.payment.invoice_reference).toContain("CI-");
    }, 90000);
  });

  describe("Full Payment Status derivation", () => {
    it("UNPAID before any Proforma Invoice exists", async () => {
      const { po } = await createSentPo();
      const res = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.body.data.status).toBe("UNPAID");
    });

    it("FULLY_PAID once a Commercial Invoice is issued against a fully-advance-paid Proforma (server-derived total already fully covered by construction)", async () => {
      const { po, supplier } = await createShippedPo();
      await payProformaInFull(po.id, supplier.id);
      await request(app)
        .post(`/purchase-orders/${po.id}/commercial-invoices`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});

      const res = await request(app).get(`/purchase-orders/${po.id}/payment-status`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.body.data.status).toBe("FULLY_PAID");
    });

    it("PARTIALLY_PAID after a supersede raises the total above what's already been paid", async () => {
      const { po, supplier } = await createShippedPo(10, 10); // total = 100
      await payProformaInFull(po.id, supplier.id);
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

    it("OVERDUE for NET_30 terms once the due date has passed", async () => {
      const { po, supplier } = await createShippedPo(10, 10, "net_30");
      await payProformaInFull(po.id, supplier.id);
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
      const { po: prepaymentPo, supplier } = await createShippedPo(10, 10);
      await payProformaInFull(prepaymentPo.id, supplier.id);
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
      const { po } = await createSentPo();
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

    const { po } = await createShippedPo();
    const res = await request(app)
      .post(`/purchase-orders/${po.id}/commercial-invoices`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({});
    expect(res.status).toBe(404);
  });
});
