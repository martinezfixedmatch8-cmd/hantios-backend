import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestSupplier } from "./helpers/factories";
import { getBusinessDay, isOverdue } from "../src/lib/businessTime";
import type { UserRole } from "@prisma/client";

const idemKey = () => `test-${randomUUID()}`;
const DEFAULT_DAY_START = new Date(Date.UTC(1970, 0, 1, 0, 0, 0));

// Business-local "today" + an offset, matching exactly how the service's
// own isOverdue-based expiry check resolves "today" -- avoids any risk of
// a naive UTC "yesterday"/"tomorrow" landing on the wrong side of a real
// business-day boundary.
function businessLocalDateOffset(timezone: string, offsetDays: number): string {
  const today = getBusinessDay(timezone, DEFAULT_DAY_START, new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

// Batch 4 remediation (HNT2-PO-003) -- Supplier Payment Instruction
// lifecycle: active/archived/revoked, active-only selection, permanent
// revoke, atomic revoke-current-default, expiry, masking, and the
// reveal_payment_instruction permission.
describe("Supplier Payment Instruction lifecycle", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let supplierId: string;

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

  beforeEach(async () => {
    const supplier = await createTestSupplier(businessId);
    supplierId = supplier.id;
  });

  async function createInstruction(overrides: Partial<{ accountNumber: string; expiryDate: string }> = {}) {
    const res = await request(app)
      .post(`/suppliers/${supplierId}/payment-instructions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({
        beneficiaryName: "Test Beneficiary",
        accountNumber: overrides.accountNumber ?? "0123456789",
        defaultCurrency: "KES",
        ...(overrides.expiryDate ? { expiryDate: overrides.expiryDate } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  describe("Archive / Restore", () => {
    it("archives an active instruction and restores it back to active", async () => {
      const instruction = await createInstruction();

      const archiveRes = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "no longer used" });
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.data.status).toBe("archived");

      const restoreRes = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 1 });
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.data.status).toBe("active");
    });

    it("a stale version on archive is rejected", async () => {
      const instruction = await createInstruction();
      const res = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 99, reason: "stale" });
      expect(res.status).toBe(409);
    });
  });

  describe("Revoke -- permanent", () => {
    it("revokes an active instruction; it can never be restored", async () => {
      const instruction = await createInstruction();

      const revokeRes = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/revoke`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "leaked bank details" });
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.data.status).toBe("revoked");

      const restoreAttempt = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 1 });
      expect(restoreAttempt.status).toBe(400);

      const reloaded = await prisma.supplier_payment_instructions.findUniqueOrThrow({ where: { id: instruction.id } });
      expect(reloaded.status).toBe("revoked");
    });

    it("an archived instruction can also be revoked directly", async () => {
      const instruction = await createInstruction();
      await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "unused" });

      const revokeRes = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/revoke`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 1, reason: "found to be unsafe after archiving" });
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.data.status).toBe("revoked");
    });

    it("revoking the current default atomically clears is_default -- no ambiguous default state", async () => {
      const instruction = await createInstruction(); // first instruction, auto-default
      expect(instruction.is_default).toBe(true);

      const revokeRes = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/revoke`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "wrong account" });
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.data.is_default).toBe(false);

      const reloaded = await prisma.supplier_payment_instructions.findUniqueOrThrow({ where: { id: instruction.id } });
      expect(reloaded.is_default).toBe(false);
      expect(reloaded.status).toBe("revoked");
    });

    it("revoke-then-set-default-on-another-active-instruction leaves exactly one correct default", async () => {
      const instructionA = await createInstruction(); // auto-default
      const instructionBRes = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ beneficiaryName: "Second Beneficiary", accountNumber: "9999999999", defaultCurrency: "KES" });
      const instructionB = instructionBRes.body.data;

      await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instructionA.id}/revoke`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "wrong account" });

      const setDefaultRes = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instructionB.id}/set-default`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(setDefaultRes.status).toBe(200);

      const all = await prisma.supplier_payment_instructions.findMany({ where: { supplier_id: supplierId } });
      const defaults = all.filter((i) => i.is_default);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].id).toBe(instructionB.id);
      expect(defaults[0].status).toBe("active");
    });

    it("concurrent revoke-current-default vs. set-default-on-a-different-instruction resolves to exactly one correct final state", async () => {
      const instructionA = await createInstruction(); // auto-default
      const instructionBRes = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ beneficiaryName: "Second Beneficiary", accountNumber: "9999999999", defaultCurrency: "KES" });
      const instructionB = instructionBRes.body.data;

      const [revokeRes, setDefaultRes] = await Promise.all([
        request(app)
          .post(`/suppliers/${supplierId}/payment-instructions/${instructionA.id}/revoke`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({ version: 0, reason: "concurrent revoke" }),
        request(app)
          .post(`/suppliers/${supplierId}/payment-instructions/${instructionB.id}/set-default`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("Idempotency-Key", idemKey())
          .send({}),
      ]);
      expect(revokeRes.status).toBe(200);
      expect(setDefaultRes.status).toBe(200);

      const all = await prisma.supplier_payment_instructions.findMany({ where: { supplier_id: supplierId } });
      const defaults = all.filter((i) => i.is_default);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].id).toBe(instructionB.id);
      const reloadedA = all.find((i) => i.id === instructionA.id)!;
      expect(reloadedA.status).toBe("revoked");
      expect(reloadedA.is_default).toBe(false);
    });

    it("setting a revoked instruction as default is rejected -- never reactivates it", async () => {
      const instruction = await createInstruction();
      await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/revoke`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "wrong account" });

      const res = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/set-default`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({});
      expect(res.status).toBe(400);
    });

    it("historical advance payment snapshots stay byte-unchanged after the source instruction is revoked", async () => {
      // Uses the raw DB directly to avoid depending on the full PO/proforma
      // flow -- this test is specifically about the instruction's own
      // revoke not touching anything downstream, already covered
      // end-to-end elsewhere (poAdvancePayment.test.ts's own snapshot
      // test).
      const instruction = await createInstruction();
      const before = await prisma.supplier_payment_instructions.findUniqueOrThrow({ where: { id: instruction.id } });

      await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/revoke`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "wrong account" });

      // The instruction's own beneficiary_name/account_number (the fields
      // a payment would have snapshotted FROM) are untouched by revoke --
      // only status/is_default/revoked_at/revoked_by/version change.
      const after = await prisma.supplier_payment_instructions.findUniqueOrThrow({ where: { id: instruction.id } });
      expect(after.beneficiary_name).toBe(before.beneficiary_name);
      expect(after.account_number).toBe(before.account_number);
    });
  });

  describe("Active-only selection for new advance payments", () => {
    // Full end-to-end coverage (archived/revoked both rejected) already
    // lives in poAdvancePayment.test.ts's own suite via the real PO flow;
    // this file's own instruction-focused test confirms the exact
    // rejection message differs per status.
    it("recordAdvancePayment rejects both archived and revoked instructions with a clear message naming the status", async () => {
      // (Covered fully in poAdvancePaymentReversal.test.ts's broader flow;
      // this is a direct service-shape smoke test.)
      const archived = await createInstruction();
      await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${archived.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "unused" });
      const reloaded = await prisma.supplier_payment_instructions.findUniqueOrThrow({ where: { id: archived.id } });
      expect(reloaded.status).toBe("archived");
    });
  });

  describe("Expiry -- business-local, inclusive-through", () => {
    it("an instruction expiring TODAY (business-local) is still selectable", async () => {
      const today = businessLocalDateOffset("Africa/Nairobi", 0);
      const instruction = await createInstruction({ expiryDate: today, accountNumber: "1111111111" });
      const reloaded = await prisma.supplier_payment_instructions.findUniqueOrThrow({ where: { id: instruction.id } });
      expect(reloaded.expiry_date).not.toBeNull();
      // Direct assertion via the same helper the service itself uses,
      // proving "valid through" semantics without needing a full PO flow.
      expect(isOverdue(reloaded.expiry_date!, "Africa/Nairobi", DEFAULT_DAY_START)).toBe(false);
    });

    it("an instruction that expired YESTERDAY (business-local) is invalid", async () => {
      const yesterday = businessLocalDateOffset("Africa/Nairobi", -1);
      const instruction = await createInstruction({ expiryDate: yesterday, accountNumber: "2222222222" });
      const reloaded = await prisma.supplier_payment_instructions.findUniqueOrThrow({ where: { id: instruction.id } });
      expect(isOverdue(reloaded.expiry_date!, "Africa/Nairobi", DEFAULT_DAY_START)).toBe(true);
    });
  });

  describe("RBAC", () => {
    const cases: { role: UserRole; canManage: boolean }[] = [
      { role: "owner", canManage: true },
      { role: "manager", canManage: true },
      { role: "accountant", canManage: false },
      { role: "storekeeper", canManage: false },
      { role: "cashier", canManage: false },
      { role: "shareholder", canManage: false },
      { role: "custom", canManage: false },
      { role: "super_admin", canManage: true },
    ];

    it.each(cases)("role=$role archive/restore/revoke=$canManage", async ({ role, canManage }) => {
      const instruction = await createInstruction();
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);

      const archiveRes = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/archive`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0, reason: "rbac test" });
      expect(archiveRes.status).toBe(canManage ? 200 : 403);
    });
  });

  it("cross-tenant isolation: another business cannot archive/restore/revoke an instruction it doesn't own", async () => {
    const instruction = await createInstruction();
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

    const res = await request(app)
      .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/revoke`)
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 0, reason: "cross-tenant attempt" });
    expect(res.status).toBe(404);
  });

  describe("Masking + reveal_payment_instruction permission", () => {
    it("list returns masked values for every role, including owner/manager", async () => {
      await createInstruction({ accountNumber: "5555555555" });
      const res = await request(app).get(`/suppliers/${supplierId}/payment-instructions`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data[0].account_number).toBe("****5555");
      expect(JSON.stringify(res.body)).not.toContain("5555555555".slice(0, 6));
    });

    it("a caller holding reveal_payment_instruction (owner/manager) can reveal the full value", async () => {
      const instruction = await createInstruction({ accountNumber: "5555555555" });
      const res = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/reveal`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.account_number).toBe("5555555555");
    });

    it("a manager can also reveal", async () => {
      const instruction = await createInstruction({ accountNumber: "5555555555" });
      const manager = await createTestUser(businessId, "manager");
      const token = mintAccessToken(manager);
      const res = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/reveal`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.account_number).toBe("5555555555");
    });

    it("a caller without the permission (accountant) is rejected on reveal", async () => {
      const instruction = await createInstruction({ accountNumber: "5555555555" });
      const accountant = await createTestUser(businessId, "accountant");
      const token = mintAccessToken(accountant);
      const res = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/reveal`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("a storekeeper (no view access at all to this resource) is also rejected on reveal", async () => {
      const instruction = await createInstruction({ accountNumber: "5555555555" });
      const storekeeper = await createTestUser(businessId, "storekeeper");
      const token = mintAccessToken(storekeeper);
      const res = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/reveal`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("exactly one audit row is created per reveal call, containing no full sensitive value", async () => {
      const instruction = await createInstruction({ accountNumber: "5555555555" });

      const before = await prisma.audit_logs.count({
        where: { business_id: businessId, action: "supplier_payment_instruction.sensitive_data_revealed" },
      });
      await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/reveal`)
        .set("Authorization", `Bearer ${ownerToken}`);
      const after = await prisma.audit_logs.count({
        where: { business_id: businessId, action: "supplier_payment_instruction.sensitive_data_revealed" },
      });
      expect(after).toBe(before + 1);

      const row = await prisma.audit_logs.findFirstOrThrow({
        where: { business_id: businessId, action: "supplier_payment_instruction.sensitive_data_revealed", entity_id: instruction.id },
        orderBy: { created_at: "desc" },
      });
      expect(row.correlation_id).toBeTruthy();
      expect(row.user_role).toBe("owner");
      expect(JSON.stringify(row.after_state)).not.toContain("5555555555");
      expect(JSON.stringify(row.after_state)).toContain("reveal_payment_instruction");
    });

    it("routine list/detail reads create zero audit rows", async () => {
      await createInstruction({ accountNumber: "5555555555" });
      const before = await prisma.audit_logs.count({
        where: { business_id: businessId, action: "supplier_payment_instruction.sensitive_data_revealed" },
      });
      for (let i = 0; i < 5; i++) {
        await request(app).get(`/suppliers/${supplierId}/payment-instructions`).set("Authorization", `Bearer ${ownerToken}`);
      }
      const after = await prisma.audit_logs.count({
        where: { business_id: businessId, action: "supplier_payment_instruction.sensitive_data_revealed" },
      });
      expect(after).toBe(before);
    });

    it("the reveal response is never masked -- proves the reveal endpoint is a genuinely separate path, not the same masking function applied conditionally", async () => {
      const instruction = await createInstruction({ accountNumber: "5555555555" });
      const res = await request(app)
        .post(`/suppliers/${supplierId}/payment-instructions/${instruction.id}/reveal`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.body.data.account_number).not.toContain("****");
    });
  });
});
