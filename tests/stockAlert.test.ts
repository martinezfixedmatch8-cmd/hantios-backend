import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { domainEvents } from "../src/lib/events";
import type { DomainEventPayloads } from "../src/lib/events";
import { startStockAlertSubscriber } from "../src/lib/stockAlertSubscriber";
import { renderTemplate, type SupportedLanguage } from "../src/lib/messageTemplates";
import { setNotificationProvider, getNotificationProvider } from "../src/notifications/registry";
import { SpyNotificationProvider } from "./helpers/notificationSpy";
import { waitFor } from "./helpers/waitFor";
import { cleanupTestBusiness } from "./helpers/cleanup";
import {
  signupTestOwner,
  loginTestOwner,
  createTestUser,
  mintAccessToken,
  createTestBranch,
  createTestProduct,
  createTestBranchInventory,
} from "./helpers/factories";

describe("Low Stock Alert (Module 02)", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerId: string;
  let ownerToken: string;
  let branchId: string;
  let managerId: string;
  let managerPhone: string;
  let ownerPhone: string;
  let spy: SpyNotificationProvider;
  const originalProvider = getNotificationProvider();

  beforeAll(async () => {
    startStockAlertSubscriber();

    const owner = await signupTestOwner();
    businessId = owner.businessId;
    ownerId = owner.ownerId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;

    const ownerUser = await prisma.users.update({
      where: { id: ownerId },
      data: { phone_verified_at: new Date() },
    });
    ownerPhone = ownerUser.phone;

    const branch = await createTestBranch(businessId);
    branchId = branch.id;

    const manager = await createTestUser(businessId, "manager");
    const updatedManager = await prisma.users.update({
      where: { id: manager.id },
      data: { branch_id: branchId, phone_verified_at: new Date() },
    });
    managerId = updatedManager.id;
    managerPhone = updatedManager.phone;
  });

  afterAll(async () => {
    setNotificationProvider(originalProvider);
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  beforeEach(() => {
    spy = new SpyNotificationProvider();
    setNotificationProvider(spy);
  });

  // The default fixture has exactly 2 real recipients for a StockLow event on
  // `businessId`: the branch manager and the business owner (Req 5). Waiting
  // on the audit rows those two produce (rather than on spy.sent.length) is
  // the precise completion signal -- each recipient's loop iteration in
  // stockAlertSubscriber.ts writes its audit row strictly after its send, so
  // once both rows exist, both sends are guaranteed to have landed too. This
  // also prevents a straggling async send from a slow last recipient leaking
  // into the NEXT test's freshly-swapped spy.
  const DEFAULT_RECIPIENT_IDS = () => [managerId, ownerId];

  async function waitForAlertSettled(productName: string, recipientIds: string[] = DEFAULT_RECIPIENT_IDS()) {
    await waitFor(async () => {
      const rows = await prisma.audit_logs.findMany({
        where: { business_id: businessId, action: "inventory.low_stock_alert_sent", entity_id: { in: recipientIds } },
      });
      return rows.filter((r) => r.reason.includes(productName)).length >= recipientIds.length;
    });
  }

  async function waitForRecoverySettled(productId: string) {
    await waitFor(async () => {
      const rows = await prisma.audit_logs.findMany({
        where: { business_id: businessId, action: "inventory.stock_recovered", entity_id: productId },
      });
      return rows.length >= 1;
    });
  }

  async function setupProduct(minStockLevel: number, startingQuantity: number) {
    const product = await createTestProduct(businessId, { minStockLevel });
    await createTestBranchInventory(businessId, branchId, product.id, { quantity: startingQuantity });
    return product;
  }

  async function decreaseStock(productId: string, quantity: number, adjustmentType = "damage") {
    const res = await request(app)
      .post(`/products/${productId}/stock-adjustment`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ branchId, quantity, direction: "decrease", adjustmentType, reason: "test decrease" });
    if (res.status !== 201) throw new Error(`decreaseStock failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  async function increaseStock(productId: string, quantity: number, adjustmentType = "found") {
    const res = await request(app)
      .post(`/products/${productId}/stock-adjustment`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ branchId, quantity, direction: "increase", adjustmentType, reason: "test increase" });
    if (res.status !== 201) throw new Error(`increaseStock failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  async function auditRowsFor(action: string, entityId: string) {
    return prisma.audit_logs.findMany({ where: { business_id: businessId, action, entity_id: entityId } });
  }

  it("crossing the threshold via a stock-adjustment decrease fires StockLow exactly once per recipient, with correct severity and no color field", async () => {
    const product = await setupProduct(10, 20);

    let capturedPayload: DomainEventPayloads["StockLow"] | undefined;
    domainEvents.once("StockLow", (payload) => {
      capturedPayload = payload;
    });

    await decreaseStock(product.id, 15); // 20 -> 5 => at/below 10, and <= 10/2=5 => critical

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.severity).toBe("critical");
    expect(capturedPayload!.currentQuantity).toBe("5");
    expect(capturedPayload!.minStockLevel).toBe("10");
    expect(Object.keys(capturedPayload!)).not.toContain("color");

    await waitForAlertSettled(product.name);
    expect(spy.sent).toHaveLength(2); // one per recipient: manager + owner
    const managerMsg = spy.sent.find((n) => n.to === managerPhone);
    const ownerMsg = spy.sent.find((n) => n.to === ownerPhone);
    expect(managerMsg).toMatchObject({ category: "BUSINESS_OPERATIONS", channel: "whatsapp" });
    expect(ownerMsg).toMatchObject({ category: "BUSINESS_OPERATIONS", channel: "whatsapp" });
    expect(managerMsg!.body).not.toMatch(/#[0-9a-f]{3,6}\b/i);

    const row = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
    expect(row?.low_stock_alert_active).toBe(true);
    expect(row?.low_stock_alerted_at).not.toBeNull();
  });

  it("staying low on a further decrease does not re-fire", async () => {
    const product = await setupProduct(10, 20);
    await decreaseStock(product.id, 15); // 20 -> 5, entered
    await waitForAlertSettled(product.name);
    expect(spy.sent).toHaveLength(2);

    await decreaseStock(product.id, 2); // 5 -> 3, still low, must not re-fire
    // No new event will ever land for this second call, so a bounded sleep
    // (not a poll-for-presence) is the only way to assert continued absence.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spy.sent).toHaveLength(2);

    const managerRows = (await auditRowsFor("inventory.low_stock_alert_sent", managerId)).filter((r) =>
      r.reason.includes(product.name)
    );
    expect(managerRows).toHaveLength(1);
  });

  it("recovering via a stock-adjustment increase clears the debounce, fires StockRecovered, and sends no WhatsApp message", async () => {
    const product = await setupProduct(10, 20);
    await decreaseStock(product.id, 15); // 20 -> 5, entered
    await waitForAlertSettled(product.name);
    expect(spy.sent).toHaveLength(2);

    let recoveredPayload: DomainEventPayloads["StockRecovered"] | undefined;
    domainEvents.once("StockRecovered", (payload) => {
      recoveredPayload = payload;
    });

    await increaseStock(product.id, 10); // 5 -> 15, above minStockLevel of 10

    expect(recoveredPayload).toBeDefined();
    expect(recoveredPayload!.severity).toBeNull();
    expect(recoveredPayload!.currentQuantity).toBe("15");

    await waitForRecoverySettled(product.id);

    const row = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
    expect(row?.low_stock_alert_active).toBe(false);
    expect(row?.low_stock_alerted_at).toBeNull();

    // Recovery is event + audit only -- confirmed decision, no WhatsApp send.
    expect(spy.sent).toHaveLength(2); // still just the original StockLow sends
  });

  it("dropping again after recovery re-fires StockLow", async () => {
    const product = await setupProduct(10, 20);
    await decreaseStock(product.id, 15); // 20 -> 5, entered
    await waitForAlertSettled(product.name);
    expect(spy.sent).toHaveLength(2);

    await increaseStock(product.id, 10); // 5 -> 15, recovered
    await waitForRecoverySettled(product.id);

    await decreaseStock(product.id, 10); // 15 -> 5, entered again
    await waitFor(async () => spy.sent.length >= 4);
    expect(spy.sent).toHaveLength(4);
  });

  it("an adjustment that increases stock never fires StockLow, even when it creates a fresh below-threshold opening balance", async () => {
    const product = await createTestProduct(businessId, { minStockLevel: 100 });

    let fired = false;
    domainEvents.once("StockLow", () => {
      fired = true;
    });

    // Opening balance far below minStockLevel -- direction is "increase", so
    // per the locked requirement this must never trigger StockLow, even
    // though the resulting quantity is deep in "critical" territory.
    const res = await request(app)
      .post(`/products/${product.id}/stock-adjustment`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ branchId, quantity: 5, direction: "increase", adjustmentType: "opening_balance", reason: "test" });
    expect(res.status).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fired).toBe(false);
    expect(spy.sent).toHaveLength(0);

    const row = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
    expect(row?.low_stock_alert_active).toBe(false);
  });

  it("a sale line-item decrement that crosses the threshold fires StockLow via the createSale path", async () => {
    const product = await setupProduct(5, 6);
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);

    let capturedPayload: DomainEventPayloads["StockLow"] | undefined;
    domainEvents.once("StockLow", (payload) => {
      capturedPayload = payload;
    });

    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `test-${product.id}`)
      .send({ branchId, items: [{ productId: product.id, quantity: 2 }] }); // 6 -> 4, at/below 5
    expect(res.status).toBe(201);

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.severity).toBe("low");
    expect(capturedPayload!.currentQuantity).toBe("4");

    await waitForAlertSettled(product.name);
    expect(spy.sent).toHaveLength(2);
  });

  it("voiding a sale that restores stock above the threshold fires StockRecovered", async () => {
    const product = await setupProduct(5, 6);
    const res = await request(app)
      .post("/sales")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", `test-void-${product.id}`)
      .send({ branchId, items: [{ productId: product.id, quantity: 2 }] }); // 6 -> 4, entered
    expect(res.status).toBe(201);
    await waitForAlertSettled(product.name);

    let recoveredPayload: DomainEventPayloads["StockRecovered"] | undefined;
    domainEvents.once("StockRecovered", (payload) => {
      recoveredPayload = payload;
    });

    const voidRes = await request(app)
      .post(`/sales/${res.body.data.id}/void`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", `test-void2-${product.id}`)
      .send({ version: res.body.data.version, reason: "test void" });
    expect(voidRes.status).toBe(200);

    expect(recoveredPayload).toBeDefined();
    expect(recoveredPayload!.currentQuantity).toBe("6");
    await waitForRecoverySettled(product.id);
  });

  it("sends the correctly localized message in all 5 launch languages", async () => {
    for (const lang of ["en", "so", "ar", "fr", "es"] satisfies SupportedLanguage[]) {
      await prisma.businesses.update({ where: { id: businessId }, data: { language: lang } });
      const product = await setupProduct(10, 20);
      spy.sent = [];

      await decreaseStock(product.id, 15); // 20 -> 5
      await waitForAlertSettled(product.name);
      expect(spy.sent).toHaveLength(2);

      const expected = renderTemplate("low_stock_alert", lang, {
        productName: product.name,
        quantity: "5",
        minStockLevel: "10",
        branchName: (await prisma.branches.findUniqueOrThrow({ where: { id: branchId } })).name,
      });
      for (const n of spy.sent) {
        expect(n.body).toBe(expected);
      }
    }
    await prisma.businesses.update({ where: { id: businessId }, data: { language: "en" } });
  });

  it("notifies every verified/active branch manager and every verified/active business owner, and no one else", async () => {
    const otherBranch = await createTestBranch(businessId);
    const managerOtherBranch = await createTestUser(businessId, "manager");
    await prisma.users.update({
      where: { id: managerOtherBranch.id },
      data: { branch_id: otherBranch.id, phone_verified_at: new Date() },
    });

    const cashierSameBranch = await createTestUser(businessId, "cashier");
    await prisma.users.update({
      where: { id: cashierSameBranch.id },
      data: { branch_id: branchId, phone_verified_at: new Date() },
    });

    const managerUnverified = await createTestUser(businessId, "manager");
    await prisma.users.update({ where: { id: managerUnverified.id }, data: { branch_id: branchId } });

    const managerArchived = await createTestUser(businessId, "manager");
    await prisma.users.update({
      where: { id: managerArchived.id },
      data: { branch_id: branchId, phone_verified_at: new Date(), status: "archived" },
    });

    const product = await setupProduct(10, 20);
    await decreaseStock(product.id, 15);
    await waitForAlertSettled(product.name);

    const recipientPhones = spy.sent.map((n) => n.to).sort();
    expect(recipientPhones).toEqual([managerPhone, ownerPhone].sort());
  });

  it("writes one audit row per recipient with the delivery outcome, and a distinct row when zero recipients match", async () => {
    const product = await setupProduct(10, 20);
    await decreaseStock(product.id, 15);
    await waitForAlertSettled(product.name);

    const managerRows = (await auditRowsFor("inventory.low_stock_alert_sent", managerId)).filter((r) =>
      r.reason.includes(product.name)
    );
    expect(managerRows.some((r) => r.reason.includes("sent"))).toBe(true);

    const ownerRows = (await auditRowsFor("inventory.low_stock_alert_sent", ownerId)).filter((r) =>
      r.reason.includes(product.name)
    );
    expect(ownerRows.some((r) => r.reason.includes("sent"))).toBe(true);

    // Zero-recipient case: an isolated business with no verified staff at all.
    const isolated = await signupTestOwner();
    businessIds.push(isolated.businessId);
    const isolatedBranch = await createTestBranch(isolated.businessId);
    const isolatedProduct = await createTestProduct(isolated.businessId, { minStockLevel: 10 });
    await createTestBranchInventory(isolated.businessId, isolatedBranch.id, isolatedProduct.id, { quantity: 20 });

    const isolatedLogin = await loginTestOwner(isolated.email, isolated.password, isolated.deviceId);
    const beforeCount = spy.sent.length;
    const decRes = await request(app)
      .post(`/products/${isolatedProduct.id}/stock-adjustment`)
      .set("Authorization", `Bearer ${isolatedLogin.accessToken}`)
      .send({ branchId: isolatedBranch.id, quantity: 15, direction: "decrease", adjustmentType: "damage", reason: "test" });
    expect(decRes.status).toBe(201);

    await waitFor(async () => {
      const rows = await prisma.audit_logs.findMany({
        where: { business_id: isolated.businessId, action: "inventory.low_stock_alert_sent", entity_id: isolatedProduct.id },
      });
      return rows.length >= 1;
    });
    const noRecipientRows = await prisma.audit_logs.findMany({
      where: { business_id: isolated.businessId, action: "inventory.low_stock_alert_sent", entity_id: isolatedProduct.id },
    });
    expect(noRecipientRows).toHaveLength(1);
    expect(noRecipientRows[0].reason).toMatch(/no recipients matched/);
    // Confirms the isolated business's own (unverified-phone) owner never received anything.
    expect(spy.sent).toHaveLength(beforeCount);
  });

  it("cross-business isolation: a low-stock event in one business never notifies another business's recipients", async () => {
    const other = await signupTestOwner();
    businessIds.push(other.businessId);
    await prisma.users.update({ where: { id: other.ownerId }, data: { phone_verified_at: new Date() } });
    const otherBranch = await createTestBranch(other.businessId);
    const otherManager = await createTestUser(other.businessId, "manager");
    const updatedOtherManager = await prisma.users.update({
      where: { id: otherManager.id },
      data: { branch_id: otherBranch.id, phone_verified_at: new Date() },
    });

    const product = await setupProduct(10, 20);
    await decreaseStock(product.id, 15);
    await waitForAlertSettled(product.name);

    const recipientPhones = spy.sent.map((n) => n.to);
    expect(recipientPhones).not.toContain(updatedOtherManager.phone);

    const crossBusinessAuditRows = await prisma.audit_logs.findMany({
      where: { business_id: other.businessId, action: "inventory.low_stock_alert_sent" },
    });
    expect(crossBusinessAuditRows).toHaveLength(0);
  });

  // Regression tests for two real bugs QA reproduced live against this exact
  // DB during this session's QA pass, before the fixes below existed.

  it("regression: concurrent sales on the same branch_inventory row never double-fire StockLow, and the ledger stays consistent", async () => {
    const product = await createTestProduct(businessId, { minStockLevel: 97 });
    await createTestBranchInventory(businessId, branchId, product.id, { quantity: 100 });
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);

    // Two truly-concurrent sales, each individually decrementing 3 -- QA's
    // exact repro shape. Before the fix, both read the pre-write
    // branch_inventory snapshot (wasActive=false for both), so both
    // independently decided "entered" and both published StockLow.
    const [res1, res2] = await Promise.all([
      request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", `test-concurrent-a-${product.id}`)
        .send({ branchId, items: [{ productId: product.id, quantity: 3 }] }),
      request(app)
        .post("/sales")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", `test-concurrent-b-${product.id}`)
        .send({ branchId, items: [{ productId: product.id, quantity: 3 }] }),
    ]);
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    await waitForAlertSettled(product.name);
    // Exactly one recipient set (manager + owner = 2 sends) for the whole
    // episode -- 4 sends would mean it double-fired.
    expect(spy.sent).toHaveLength(2);

    const row = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
    expect(row?.quantity.toString()).toBe("94");
    expect(row?.low_stock_alert_active).toBe(true);

    // Ledger must reflect each sale's TRUE before/after, chaining
    // 100->97->94 in whichever order the two transactions actually
    // serialized in -- not two rows both wrongly claiming 100->97.
    const adjustments = await prisma.inventory_adjustments.findMany({
      where: { business_id: businessId, product_id: product.id },
      orderBy: { created_at: "asc" },
    });
    expect(adjustments).toHaveLength(2);
    const pairs = adjustments.map((a) => `${a.quantity_before.toString()}->${a.quantity_after.toString()}`).sort();
    expect(pairs).toEqual(["100->97", "97->94"]);
  });

  it("regression: raising min_stock_level via PATCH mid-episode does not cause a later increase to illegally fire StockLow", async () => {
    const product = await createTestProduct(businessId, { minStockLevel: 5 });
    await createTestBranchInventory(businessId, branchId, product.id, { quantity: 50 });

    // Raises minStockLevel well above the current quantity -- nothing
    // re-evaluates branch_inventory's debounce state on a product PATCH, so
    // the row stays inactive even though 50 units is now deep under the new
    // threshold.
    const patchRes = await request(app)
      .patch(`/products/${product.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ minStockLevel: 200, version: product.version });
    expect(patchRes.status).toBe(200);

    let fired = false;
    domainEvents.once("StockLow", () => {
      fired = true;
    });

    await increaseStock(product.id, 1); // 50 -> 51 -- an increase, must never enter a low-stock episode

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fired).toBe(false);
    expect(spy.sent).toHaveLength(0);

    const row = await prisma.branch_inventory.findFirst({ where: { branch_id: branchId, product_id: product.id } });
    expect(row?.low_stock_alert_active).toBe(false);
  });
});
