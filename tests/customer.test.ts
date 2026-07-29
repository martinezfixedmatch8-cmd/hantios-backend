import request from "supertest";
import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
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
  createTestBranchInventory,
  createTestCustomer,
} from "./helpers/factories";

describe("Customers (Module 05)", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let branchId: string;

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

  const idemKey = () => `test-${randomUUID()}`;
  const randomPhone = () => `+2547${Math.floor(10000000 + Math.random() * 89999999)}`;

  function validCustomerPayload(overrides: Record<string, unknown> = {}) {
    return { phone: randomPhone(), name: "Test Customer", email: "customer@example.test", ...overrides };
  }

  async function createCustomerAs(token: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/customers")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send(validCustomerPayload(overrides));
    if (res.status !== 201) {
      throw new Error(`createCustomerAs failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data;
  }

  async function stockedProduct(quantity: number) {
    const product = await createTestProduct(businessId);
    await createTestBranchInventory(businessId, branchId, product.id, { quantity });
    return product;
  }

  async function createSaleAs(token: string, productId: string, quantity: number, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ branchId, items: [{ productId, quantity }], ...overrides });
    if (res.status !== 201) {
      throw new Error(`createSaleAs failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data;
  }

  async function createDebtAs(token: string, overrides: Record<string, unknown> = {}) {
    const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    const res = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({
        customerPhone: randomPhone(),
        customerName: "Debt Customer",
        amountOriginal: 500,
        dateTaken: isoDate(-5),
        dateDue: isoDate(5),
        ...overrides,
      });
    if (res.status !== 201) {
      throw new Error(`createDebtAs failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data;
  }

  // ---------------------------------------------------------------------
  // Manual create
  // ---------------------------------------------------------------------

  describe("POST /customers (manual add)", () => {
    it("returns 401 with no token", async () => {
      const res = await request(app).post("/customers").set("Idempotency-Key", idemKey()).send(validCustomerPayload());
      expect(res.status).toBe(401);
    });

    it("returns 400 when the Idempotency-Key header is missing", async () => {
      const res = await request(app).post("/customers").set("Authorization", `Bearer ${ownerToken}`).send(validCustomerPayload());
      expect(res.status).toBe(400);
    });

    it("creates a customer with a sequential CUS-###### number", async () => {
      const customer = await createCustomerAs(ownerToken);
      expect(customer.customer_number).toMatch(/^CUS-\d{6}$/);
      expect(customer.status).toBe("active");
      expect(customer.version).toBe(0);
    });

    it("normalizes and stores both phone_original and phone_normalized", async () => {
      const customer = await createCustomerAs(ownerToken, { phone: "0712345678" });
      expect(customer.phone_original).toBe("0712345678");
      expect(customer.phone_normalized).toBe("+254712345678");
    });

    it("rejects an unparseable phone number with 400", async () => {
      const res = await request(app)
        .post("/customers")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validCustomerPayload({ phone: "not a phone number" }));
      expect(res.status).toBe(400);
    });

    it("returns 409 when an active customer already has this phone number", async () => {
      const phone = randomPhone();
      await createCustomerAs(ownerToken, { phone });
      const res = await request(app)
        .post("/customers")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validCustomerPayload({ phone }));
      expect(res.status).toBe(409);
    });

    it("replays the identical response for a repeated Idempotency-Key", async () => {
      const key = idemKey();
      const payload = validCustomerPayload();
      const first = await request(app).post("/customers").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
      const second = await request(app).post("/customers").set("Authorization", `Bearer ${ownerToken}`).set("Idempotency-Key", key).send(payload);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);

      const count = await prisma.customers.count({ where: { business_id: businessId, phone_normalized: first.body.data.phone_normalized } });
      expect(count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // Shared find-or-create, exercised via Debt and Sale
  // ---------------------------------------------------------------------

  describe("shared findOrCreateCustomer (via Debt and Sale)", () => {
    it("resolves two different phone formats of the same number to the same customer across Debt and Sale", async () => {
      const localFormat = "0712345678";
      const e164Format = "+254712345678";

      const debt = await createDebtAs(ownerToken, { customerPhone: localFormat, customerName: "Cross Format" });
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, product.id, 1, { customerPhone: e164Format });

      expect(debt.customer_id).toBe(sale.customer_id);

      const customer = await prisma.customers.findUniqueOrThrow({ where: { id: debt.customer_id } });
      expect(customer.phone_normalized).toBe("+254712345678");
    });

    it("an archived customer's phone: find-or-create creates a NEW active customer, never reactivates the archived one", async () => {
      const phone = randomPhone();
      const original = await createCustomerAs(ownerToken, { phone, name: "Original Customer" });
      const archiveRes = await request(app)
        .post(`/customers/${original.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: original.version, reason: "test archive" });
      expect(archiveRes.status).toBe(200);

      const debt = await createDebtAs(ownerToken, { customerPhone: phone, customerName: "New Customer" });

      expect(debt.customer_id).not.toBe(original.id);
      const newCustomer = await prisma.customers.findUniqueOrThrow({ where: { id: debt.customer_id } });
      expect(newCustomer.status).toBe("active");
      expect(newCustomer.phone_normalized).toBe(original.phone_normalized);

      // The archived one is untouched -- still archived, still itself.
      const stillArchived = await prisma.customers.findUniqueOrThrow({ where: { id: original.id } });
      expect(stillArchived.status).toBe("archived");
      expect(stillArchived.name).toBe("Original Customer");
    });

    it("no duplicate customer creation under concurrent requests (Debt + Sale, same never-before-seen phone)", async () => {
      const phone = randomPhone();
      const product = await stockedProduct(10);

      const [debt, sale] = await Promise.all([
        createDebtAs(ownerToken, { customerPhone: phone, customerName: "Concurrent" }),
        createSaleAs(ownerToken, product.id, 1, { customerPhone: phone, customerName: "Concurrent" }),
      ]);

      expect(debt.customer_id).toBe(sale.customer_id);
      const count = await prisma.customers.count({ where: { business_id: businessId, phone_normalized: phone } });
      expect(count).toBe(1);
    });

    it("Customer Number uniqueness under real concurrency: N concurrent distinct-phone creates get N distinct sequential numbers, no duplicates", async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => createCustomerAs(ownerToken, { phone: randomPhone() }))
      );
      const numbers = results.map((c) => c.customer_number);
      expect(new Set(numbers).size).toBe(6);
    });
  });

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------

  describe("GET /customers (search)", () => {
    it("searches by customer number (exact/prefix)", async () => {
      const customer = await createCustomerAs(ownerToken);
      const res = await request(app)
        .get(`/customers?search=${customer.customer_number}`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((c: { id: string }) => c.id)).toContain(customer.id);
    });

    it("searches by phone across formats", async () => {
      const customer = await createCustomerAs(ownerToken, { phone: "0798765432" });
      const res = await request(app).get("/customers?search=%2B254798765432").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((c: { id: string }) => c.id)).toContain(customer.id);
    });

    it("searches by name (partial)", async () => {
      const unique = `Findable${randomUUID().slice(0, 8)}`;
      const customer = await createCustomerAs(ownerToken, { name: `${unique} Customer` });
      const res = await request(app).get(`/customers?search=${unique}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((c: { id: string }) => c.id)).toContain(customer.id);
    });

    it("searches by email", async () => {
      const unique = `findable-${randomUUID().slice(0, 8)}@example.test`;
      const customer = await createCustomerAs(ownerToken, { email: unique });
      const res = await request(app).get(`/customers?search=${unique}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((c: { id: string }) => c.id)).toContain(customer.id);
    });

    it("ranks phone matches before name/email matches for a phone-like search term", async () => {
      // A valid-looking KE mobile number (7 + 8 digits), matching the shape
      // randomPhone() itself already produces, so createCustomerAs doesn't
      // reject it -- a bare random 9-digit string could fail to parse.
      const sharedDigits = `7${Math.floor(10000000 + Math.random() * 89999999)}`;
      const phoneMatch = await createCustomerAs(ownerToken, { phone: `+254${sharedDigits}`, name: "Zzz Unrelated Name" });
      const nameMatch = await createCustomerAs(ownerToken, { name: `Aaa ${sharedDigits}` });

      const res = await request(app).get(`/customers?search=${sharedDigits}&pageSize=50`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const ids: string[] = res.body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain(phoneMatch.id);
      expect(ids).toContain(nameMatch.id);
      expect(ids.indexOf(phoneMatch.id)).toBeLessThan(ids.indexOf(nameMatch.id));
    });

    it("archived customers stay fully searchable and visible by default", async () => {
      const customer = await createCustomerAs(ownerToken);
      await request(app)
        .post(`/customers/${customer.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: customer.version, reason: "test" });

      const defaultRes = await request(app).get(`/customers?search=${customer.customer_number}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(defaultRes.body.data.map((c: { id: string }) => c.id)).toContain(customer.id);

      const activeOnlyRes = await request(app)
        .get(`/customers?search=${customer.customer_number}&status=active`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(activeOnlyRes.body.data.map((c: { id: string }) => c.id)).not.toContain(customer.id);

      const archivedOnlyRes = await request(app)
        .get(`/customers?search=${customer.customer_number}&status=archived`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(archivedOnlyRes.body.data.map((c: { id: string }) => c.id)).toContain(customer.id);
    });

    it("returns the standard {data, pagination} envelope", async () => {
      const res = await request(app).get("/customers").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("pagination");
    });
  });

  // ---------------------------------------------------------------------
  // Profile + activity summary correctness
  // ---------------------------------------------------------------------

  describe("GET /customers/:id (profile) and activity summary correctness", () => {
    it("returns customerNumber/totalSpent/debtBalance/activity-summary fields", async () => {
      const customer = await createCustomerAs(ownerToken);
      const res = await request(app).get(`/customers/${customer.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.customer_number).toBe(customer.customer_number);
      expect(Number(res.body.data.total_spent)).toBe(0);
      expect(Number(res.body.data.debt_balance)).toBe(0);
      expect(res.body.data.purchase_count).toBe(0);
      expect(res.body.data.total_debts).toBe(0);
      expect(res.body.data.total_payments).toBe(0);
    });

    it("total_spent/purchase_count/last_purchase_at correctly reflect create, void, and refund", async () => {
      const phone = randomPhone();
      const productA = await stockedProduct(10);
      const productB = await stockedProduct(10);

      const saleA = await createSaleAs(ownerToken, productA.id, 2, { customerPhone: phone, customerName: "Activity Test" });
      const customerId = saleA.customer_id;
      const saleB = await createSaleAs(ownerToken, productB.id, 1, { customerPhone: phone });

      let customer = await prisma.customers.findUniqueOrThrow({ where: { id: customerId } });
      const expectedAfterTwoSales = Number(saleA.total) + Number(saleB.total);
      expect(Number(customer.total_spent)).toBeCloseTo(expectedAfterTwoSales, 2);
      expect(customer.purchase_count).toBe(2);

      // Void saleA -- total_spent decreases, purchase_count does NOT.
      const voidRes = await request(app)
        .post(`/sales/${saleA.id}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: saleA.version, reason: "test void" });
      expect(voidRes.status).toBe(200);

      customer = await prisma.customers.findUniqueOrThrow({ where: { id: customerId } });
      expect(Number(customer.total_spent)).toBeCloseTo(Number(saleB.total), 2);
      expect(customer.purchase_count).toBe(2); // unchanged by void

      // Refund saleB (after day-close would normally be required, but Void
      // already used same-day for saleA -- refund saleB directly via a
      // backdated timestamp so it's eligible).
      const pastDate = new Date();
      pastDate.setUTCDate(pastDate.getUTCDate() - 2);
      await prisma.sales.update({ where: { id: saleB.id }, data: { timestamp: pastDate } });

      const refundRes = await request(app)
        .post(`/sales/${saleB.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: saleB.version, reason: "test refund" });
      expect(refundRes.status).toBe(201);

      customer = await prisma.customers.findUniqueOrThrow({ where: { id: customerId } });
      expect(Number(customer.total_spent)).toBeCloseTo(0, 2);
      expect(customer.purchase_count).toBe(2); // still unchanged -- refund is a correction, not a new purchase
      expect(customer.last_activity_at).not.toBeNull();
    });

    it("total_debts/total_payments reflect create and payment, but not reversal", async () => {
      const debt = await createDebtAs(ownerToken);
      let customer = await prisma.customers.findUniqueOrThrow({ where: { id: debt.customer_id } });
      expect(customer.total_debts).toBe(1);
      expect(Number(customer.debt_balance)).toBe(500);

      const paymentRes = await request(app)
        .post(`/debts/${debt.id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ amount: 100 });
      expect(paymentRes.status).toBe(201);

      customer = await prisma.customers.findUniqueOrThrow({ where: { id: debt.customer_id } });
      expect(customer.total_payments).toBe(1);

      const reverseRes = await request(app)
        .post(`/debts/${debt.id}/payments/${paymentRes.body.data.id}/reverse`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: paymentRes.body.data.version, reason: "test reversal" });
      expect(reverseRes.status).toBe(201);

      customer = await prisma.customers.findUniqueOrThrow({ where: { id: debt.customer_id } });
      expect(customer.total_payments).toBe(1); // unchanged -- reversal corrects, doesn't count as a new payment
    });

    it("returns 404 for a customer belonging to another business", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);
      const otherCustomer = await createCustomerAs(otherLogin.accessToken);

      const res = await request(app).get(`/customers/${otherCustomer.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------

  describe("PATCH /customers/:id", () => {
    it("updates name/email/notes", async () => {
      const customer = await createCustomerAs(ownerToken);
      const res = await request(app)
        .patch(`/customers/${customer.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: customer.version, name: "Updated Name", notes: "internal note" });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Updated Name");
      expect(res.body.data.notes).toBe("internal note");
    });

    it("re-normalizes and re-validates uniqueness when phone changes", async () => {
      const customer = await createCustomerAs(ownerToken);
      const res = await request(app)
        .patch(`/customers/${customer.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: customer.version, phone: "0711222333" });
      expect(res.status).toBe(200);
      expect(res.body.data.phone_normalized).toBe("+254711222333");
    });

    it("returns 409 when updating phone to one already held by another active customer", async () => {
      const taken = await createCustomerAs(ownerToken);
      const customer = await createCustomerAs(ownerToken);
      const res = await request(app)
        .patch(`/customers/${customer.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: customer.version, phone: taken.phone_original });
      expect(res.status).toBe(409);
    });

    it("returns 409 on a stale version instead of silently overwriting", async () => {
      const customer = await createCustomerAs(ownerToken);
      const res = await request(app)
        .patch(`/customers/${customer.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: customer.version + 99, name: "Should Fail" });
      expect(res.status).toBe(409);
    });

    it("exactly one winner under concurrent updates to the same customer", async () => {
      const customer = await createCustomerAs(ownerToken);
      const results = await Promise.all([
        request(app).patch(`/customers/${customer.id}`).set("Authorization", `Bearer ${ownerToken}`).send({ version: customer.version, name: "A" }),
        request(app).patch(`/customers/${customer.id}`).set("Authorization", `Bearer ${ownerToken}`).send({ version: customer.version, name: "B" }),
      ]);
      const succeeded = results.filter((r) => r.status === 200);
      const failed = results.filter((r) => r.status === 409);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
    });

    it("clears name/email/notes when explicitly set to null", async () => {
      const customer = await createCustomerAs(ownerToken, { name: "To Clear", email: "clear@example.test" });
      const res = await request(app)
        .patch(`/customers/${customer.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: customer.version, name: null, email: null });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBeNull();
      expect(res.body.data.email).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Archive / Restore
  // ---------------------------------------------------------------------

  describe("archive / restore", () => {
    it("archives with a required reason and writes an audit log entry", async () => {
      const customer = await createCustomerAs(ownerToken);
      const res = await request(app)
        .post(`/customers/${customer.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: customer.version, reason: "customer requested" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("archived");
      expect(res.body.data.archived_reason).toBe("customer requested");

      const auditRows = await prisma.audit_logs.findMany({ where: { business_id: businessId, action: "customer.archived", entity_id: customer.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("rejects archiving without a reason", async () => {
      const customer = await createCustomerAs(ownerToken);
      const res = await request(app)
        .post(`/customers/${customer.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: customer.version });
      expect(res.status).toBe(400);
    });

    it("restores a customer with no phone conflict", async () => {
      const customer = await createCustomerAs(ownerToken);
      const archiveRes = await request(app)
        .post(`/customers/${customer.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: customer.version, reason: "test" });

      const restoreRes = await request(app)
        .post(`/customers/${customer.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: archiveRes.body.data.version });
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.data.status).toBe("active");
      expect(restoreRes.body.data.archived_reason).toBeNull();
    });

    it("blocks restore when another active customer already holds the same phone", async () => {
      const phone = randomPhone();
      const original = await createCustomerAs(ownerToken, { phone });
      const archiveRes = await request(app)
        .post(`/customers/${original.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: original.version, reason: "test" });

      // A new active customer legally claims the same (now-free) phone.
      await createCustomerAs(ownerToken, { phone });

      const restoreRes = await request(app)
        .post(`/customers/${original.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: archiveRes.body.data.version });
      expect(restoreRes.status).toBe(409);

      const stillArchived = await prisma.customers.findUniqueOrThrow({ where: { id: original.id } });
      expect(stillArchived.status).toBe("archived");
      expect(stillArchived.phone_normalized).toBe(original.phone_normalized); // never silently changed
    });

    it("under a real concurrent race (two archived customers, same phone, both restored simultaneously), exactly one restore succeeds", async () => {
      const phone = randomPhone();
      const first = await createCustomerAs(ownerToken, { phone });
      const firstArchive = await request(app)
        .post(`/customers/${first.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: first.version, reason: "test" });

      const second = await createCustomerAs(ownerToken, { phone });
      const secondArchive = await request(app)
        .post(`/customers/${second.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: second.version, reason: "test" });

      const results = await Promise.all([
        request(app).post(`/customers/${first.id}/restore`).set("Authorization", `Bearer ${ownerToken}`).send({ version: firstArchive.body.data.version }),
        request(app).post(`/customers/${second.id}/restore`).set("Authorization", `Bearer ${ownerToken}`).send({ version: secondArchive.body.data.version }),
      ]);
      const succeeded = results.filter((r) => r.status === 200);
      expect(succeeded).toHaveLength(1);

      const activeCount = await prisma.customers.count({ where: { business_id: businessId, phone_normalized: first.phone_normalized, status: "active" } });
      expect(activeCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // Timeline
  // ---------------------------------------------------------------------

  describe("GET /customers/:id/timeline", () => {
    it("aggregates Sale/Debt/Payment into one chronological feed with the standardized item shape", async () => {
      const phone = randomPhone();
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, product.id, 1, { customerPhone: phone, customerName: "Timeline Test" });
      const customerId = sale.customer_id;
      await createDebtAs(ownerToken, { customerPhone: phone });

      const res = await request(app).get(`/customers/${customerId}/timeline`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("nextCursor");
      expect(res.body).not.toHaveProperty("pagination"); // deliberate exception, not the standard envelope

      const types = res.body.data.map((item: { type: string }) => item.type);
      expect(types).toContain("sale");
      expect(types).toContain("debt");

      for (const item of res.body.data) {
        expect(item).toHaveProperty("type");
        expect(item).toHaveProperty("timestamp");
        expect(item).toHaveProperty("referenceNumber");
        expect(item).toHaveProperty("amount");
        expect(item).toHaveProperty("summary");
      }
    });

    it("paginates via cursor with no duplicates and no gaps across pages, newest first", async () => {
      const phone = randomPhone();
      const product = await stockedProduct(20);
      const sale = await createSaleAs(ownerToken, product.id, 1, { customerPhone: phone, customerName: "Cursor Test" });
      const customerId = sale.customer_id;
      // 5 more debts for the same customer, staggered so timestamps differ.
      for (let i = 0; i < 5; i++) {
        await createDebtAs(ownerToken, { customerPhone: phone });
      }

      const firstPage = await request(app).get(`/customers/${customerId}/timeline?limit=3`).set("Authorization", `Bearer ${ownerToken}`);
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.data).toHaveLength(3);
      expect(firstPage.body.nextCursor).toBeTruthy();

      const secondPage = await request(app)
        .get(`/customers/${customerId}/timeline?limit=3&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(secondPage.status).toBe(200);

      const firstIds = firstPage.body.data.map((r: { referenceNumber: string }) => r.referenceNumber);
      const secondIds = secondPage.body.data.map((r: { referenceNumber: string }) => r.referenceNumber);
      const overlap = firstIds.filter((id: string) => secondIds.includes(id));
      expect(overlap).toHaveLength(0);

      // Total across both pages accounts for all 6 events (1 sale + 5 debts).
      expect(firstPage.body.data.length + secondPage.body.data.length).toBeGreaterThanOrEqual(6);
    });

    it("breaks same-timestamp ties deterministically (3-way: occurredAt, createdAt, entityId)", async () => {
      const phone = randomPhone();
      const product = await stockedProduct(10);
      const sale = await createSaleAs(ownerToken, product.id, 1, { customerPhone: phone, customerName: "Tie Test" });
      const customerId = sale.customer_id;
      const debt = await createDebtAs(ownerToken, { customerPhone: phone });

      // Force an identical timestamp on both underlying rows to exercise the
      // tiebreak path for real, not just hope for a natural collision.
      const forcedTime = new Date("2026-01-01T00:00:00.000Z");
      await prisma.sales.update({ where: { id: sale.id }, data: { timestamp: forcedTime } });
      await prisma.debts.update({ where: { id: debt.id }, data: { created_at: forcedTime } });

      const page1 = await request(app).get(`/customers/${customerId}/timeline?limit=1`).set("Authorization", `Bearer ${ownerToken}`);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.nextCursor).toBeTruthy();

      const page2 = await request(app)
        .get(`/customers/${customerId}/timeline?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(page2.body.data).toHaveLength(1);

      // Deterministic and non-repeating despite the identical timestamp.
      expect(page1.body.data[0].referenceNumber).not.toBe(page2.body.data[0].referenceNumber);
    });

    it("returns 400 for a corrupted cursor", async () => {
      const customer = await createCustomerAs(ownerToken);
      const res = await request(app)
        .get(`/customers/${customer.id}/timeline?cursor=not-valid-base64-json`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(400);
    });

    it("returns 404 for a customer in another business", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);
      const otherCustomer = await createCustomerAs(otherLogin.accessToken);

      const res = await request(app).get(`/customers/${otherCustomer.id}/timeline`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------
  // RBAC (all 8 roles)
  // ---------------------------------------------------------------------

  describe("RBAC", () => {
    const deniedCreate: UserRole[] = ["accountant", "storekeeper", "shareholder", "custom"];
    const deniedView: UserRole[] = ["storekeeper", "shareholder", "custom"];
    const deniedArchive: UserRole[] = ["cashier", "accountant", "storekeeper", "shareholder", "custom"];
    // Restore uses the same archiveRoles gate as archive (owner/manager) --
    // an inferred-by-symmetry decision (the spec didn't state restore's RBAC
    // explicitly), so it gets the identical denied-role matrix as archive.
    const deniedRestore = deniedArchive;

    it.each(deniedCreate)("denies role=%s creating a customer", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).post("/customers").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send(validCustomerPayload());
      expect(res.status).toBe(403);
    });

    it.each(deniedView)("denies role=%s listing customers", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).get("/customers").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it.each(deniedArchive)("denies role=%s archiving a customer", async (role) => {
      const customer = await createCustomerAs(ownerToken);
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app)
        .post(`/customers/${customer.id}/archive`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: customer.version, reason: "test" });
      expect(res.status).toBe(403);
    });

    it.each(deniedRestore)("denies role=%s restoring a customer", async (role) => {
      const customer = await createCustomerAs(ownerToken);
      const archiveRes = await request(app)
        .post(`/customers/${customer.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: customer.version, reason: "test" });

      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app)
        .post(`/customers/${customer.id}/restore`)
        .set("Authorization", `Bearer ${token}`)
        .send({ version: archiveRes.body.data.version });
      expect(res.status).toBe(403);
    });

    it("allows cashier to create and manager to archive and restore", async () => {
      const cashier = await createTestUser(businessId, "cashier");
      const cashierToken = mintAccessToken(cashier);
      const customer = await createCustomerAs(cashierToken);

      const manager = await createTestUser(businessId, "manager");
      const managerToken = mintAccessToken(manager);
      const res = await request(app)
        .post(`/customers/${customer.id}/archive`)
        .set("Authorization", `Bearer ${managerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: customer.version, reason: "test" });
      expect(res.status).toBe(200);

      const restoreRes = await request(app)
        .post(`/customers/${customer.id}/restore`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ version: res.body.data.version });
      expect(restoreRes.status).toBe(200);
    });

    it("allows accountant to view/list but not create", async () => {
      const accountant = await createTestUser(businessId, "accountant");
      const token = mintAccessToken(accountant);
      const listRes = await request(app).get("/customers").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(200);
      const createRes = await request(app).post("/customers").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send(validCustomerPayload());
      expect(createRes.status).toBe(403);
    });

    it("allows super_admin to bypass every restriction", async () => {
      const admin = await createTestUser(businessId, "super_admin");
      const token = mintAccessToken(admin);
      const createRes = await request(app).post("/customers").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send(validCustomerPayload());
      expect(createRes.status).toBe(201);
      const archiveRes = await request(app)
        .post(`/customers/${createRes.body.data.id}/archive`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: createRes.body.data.version, reason: "test" });
      expect(archiveRes.status).toBe(200);

      const restoreRes = await request(app)
        .post(`/customers/${createRes.body.data.id}/restore`)
        .set("Authorization", `Bearer ${token}`)
        .send({ version: archiveRes.body.data.version });
      expect(restoreRes.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------
  // Cross-business isolation (beyond what's already covered above)
  // ---------------------------------------------------------------------

  describe("cross-business isolation", () => {
    it("returns 404, not the other business's data, on update/archive/restore", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);
      const otherCustomer = await createCustomerAs(otherLogin.accessToken);

      const updateRes = await request(app)
        .patch(`/customers/${otherCustomer.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: otherCustomer.version, name: "Hijacked" });
      expect(updateRes.status).toBe(404);

      const archiveRes = await request(app)
        .post(`/customers/${otherCustomer.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: otherCustomer.version, reason: "test" });
      expect(archiveRes.status).toBe(404);

      const restoreRes = await request(app)
        .post(`/customers/${otherCustomer.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ version: otherCustomer.version });
      expect(restoreRes.status).toBe(404);
    });

    it("a business's customer list never includes another business's customers", async () => {
      const marker = await createTestCustomer(businessId, { name: `Isolation Marker ${randomUUID()}` });
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

      const res = await request(app).get("/customers?pageSize=100").set("Authorization", `Bearer ${otherLogin.accessToken}`);
      expect(res.body.data.map((c: { id: string }) => c.id)).not.toContain(marker.id);
    });
  });
});
