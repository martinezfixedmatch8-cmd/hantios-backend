import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestSupplier } from "./helpers/factories";
import type { UserRole } from "@prisma/client";

describe("Supplier Payment Instructions", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;

  const idemKey = () => `test-${randomUUID()}`;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  const validBankInstruction = {
    beneficiaryName: "Acme Supplies Ltd",
    bankName: "Equity Bank",
    accountNumber: "0123456789",
    swift: "EQBLKENA",
    defaultCurrency: "KES",
  };

  describe("RBAC", () => {
    const cases: { role: UserRole; canWrite: boolean; canView: boolean }[] = [
      { role: "owner", canWrite: true, canView: true },
      { role: "manager", canWrite: true, canView: true },
      { role: "accountant", canWrite: false, canView: true },
      { role: "storekeeper", canWrite: false, canView: false },
      { role: "cashier", canWrite: false, canView: false },
      { role: "shareholder", canWrite: false, canView: false },
      { role: "custom", canWrite: false, canView: false },
      { role: "super_admin", canWrite: true, canView: true },
    ];

    it.each(cases)("role=$role write=$canWrite view=$canView", async ({ role, canWrite, canView }) => {
      const supplier = await createTestSupplier(businessId);
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const createRes = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send(validBankInstruction);
      expect(createRes.status).toBe(canWrite ? 201 : 403);

      const listRes = await request(app).get(`/suppliers/${supplier.id}/payment-instructions`).set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(canView ? 200 : 403);
    });
  });

  describe("Validation", () => {
    it("400s when none of iban/accountNumber/walletAddress is present", async () => {
      const supplier = await createTestSupplier(businessId);
      const res = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ beneficiaryName: "Nobody", defaultCurrency: "USD" });
      expect(res.status).toBe(400);
    });

    it("400s when network is set without a walletAddress", async () => {
      const supplier = await createTestSupplier(businessId);
      const res = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ beneficiaryName: "Nobody", accountNumber: "123", network: "trc20", defaultCurrency: "USD" });
      expect(res.status).toBe(400);
    });

    it("accepts a wallet-based instruction with a network", async () => {
      const supplier = await createTestSupplier(businessId);
      const res = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ beneficiaryName: "Crypto Supplier", walletAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", network: "trc20", defaultCurrency: "USD" });
      expect(res.status).toBe(201);
      expect(res.body.data.network).toBe("trc20");
    });

    it("400s an invalid defaultCurrency", async () => {
      const supplier = await createTestSupplier(businessId);
      const res = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ ...validBankInstruction, defaultCurrency: "NOTREAL" });
      expect(res.status).toBe(400);
    });

    it("400s creating an instruction for an archived supplier", async () => {
      const supplier = await createTestSupplier(businessId, { status: "archived" });
      const res = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validBankInstruction);
      expect(res.status).toBe(400);
    });
  });

  describe("Default toggle", () => {
    it("auto-defaults the supplier's first instruction, but not the second", async () => {
      const supplier = await createTestSupplier(businessId);
      const first = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validBankInstruction);
      expect(first.body.data.is_default).toBe(true);

      const second = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ beneficiaryName: "Crypto Wallet", walletAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", network: "trc20", defaultCurrency: "USD" });
      expect(second.body.data.is_default).toBe(false);
    });

    it("set-default unsets the prior default and sets the new one", async () => {
      const supplier = await createTestSupplier(businessId);
      const first = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validBankInstruction);
      const second = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ beneficiaryName: "Crypto Wallet", walletAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", network: "trc20", defaultCurrency: "USD" });

      const setDefaultRes = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions/${second.body.data.id}/set-default`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey());
      expect(setDefaultRes.status).toBe(200);
      expect(setDefaultRes.body.data.is_default).toBe(true);

      const firstReloaded = await prisma.supplier_payment_instructions.findUniqueOrThrow({ where: { id: first.body.data.id } });
      expect(firstReloaded.is_default).toBe(false);
    });

    // Unlike Proposal accept's "already resolved" guard, set-default has no
    // genuine conflicting outcome to reject: unset-then-set always runs
    // inside one transaction, so Postgres row-locking on the shared "current
    // default" row serializes two concurrent calls targeting DIFFERENT
    // instructions -- both legitimately succeed (200/200), and whichever
    // commits last correctly wins as the final default. The real invariant
    // (never two rows true at once) is what the partial unique index
    // guards, and it's what this test actually verifies.
    it("only one row is ever default at a time, even under concurrent set-default calls targeting different instructions", async () => {
      const supplier = await createTestSupplier(businessId);
      const first = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send(validBankInstruction);
      const second = await request(app)
        .post(`/suppliers/${supplier.id}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ beneficiaryName: "Crypto Wallet", walletAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", network: "trc20", defaultCurrency: "USD" });

      const [r1, r2] = await Promise.all([
        request(app)
          .post(`/suppliers/${supplier.id}/payment-instructions/${first.body.data.id}/set-default`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey()),
        request(app)
          .post(`/suppliers/${supplier.id}/payment-instructions/${second.body.data.id}/set-default`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey()),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      const rows = await prisma.supplier_payment_instructions.findMany({ where: { supplier_id: supplier.id, is_default: true } });
      expect(rows).toHaveLength(1);
    });
  });

  it("isolates payment instructions across businesses (404, not a data leak)", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const supplier = await createTestSupplier(businessId);
    const res = await request(app)
      .post(`/suppliers/${supplier.id}/payment-instructions`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send(validBankInstruction);
    expect(res.status).toBe(404);
  });
});
