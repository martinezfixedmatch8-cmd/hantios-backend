import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/lib/config";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken, createTestBranch, createTestProduct, createTestSupplier } from "./helpers/factories";
import { setEmailProvider } from "../src/notifications/registry";
import { SpyEmailProvider } from "./helpers/emailProviderSpy";
import { ConsoleEmailProvider } from "../src/notifications/ConsoleEmailProvider";
import { setStorageProvider } from "../src/storage/registry";
import { SpyStorageProvider } from "./helpers/storageSpy";
import { ConsoleStorageProvider } from "../src/storage/ConsoleStorageProvider";
import { signWebhookPayload, emailReceivedPayload } from "./helpers/resendWebhookSigning";
import type { UserRole } from "@prisma/client";

const WEBHOOK_SECRET = env.RESEND_WEBHOOK_SECRET!;
const WRONG_SECRET = "whsec_dGhpcyBpcyBkZWZpbml0ZWx5IHRoZSB3cm9uZyBvbmU=";

describe("Resend Inbound Webhook -- Email Conversation Sync (Module 33 Session 4B)", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let branchId: string;
  let spyEmailProvider: SpyEmailProvider;
  let spyStorageProvider: SpyStorageProvider;

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

  beforeEach(() => {
    spyEmailProvider = new SpyEmailProvider();
    setEmailProvider(spyEmailProvider, "spy");
    spyStorageProvider = new SpyStorageProvider();
    setStorageProvider(spyStorageProvider);
  });

  afterEach(() => {
    setEmailProvider(new ConsoleEmailProvider(), "console");
    setStorageProvider(new ConsoleStorageProvider());
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  // Creates a sent PO with a supplier that has a real email, generates the
  // secure link (lazily creating negotiation_reply_token as a side effect,
  // same as any real owner action would), and returns the resulting reply-
  // to local-part token read directly from the DB.
  async function createSentPoWithReplyToken(supplierEmail = `supplier-${randomUUID()}@example.test`, targetBusinessId = businessId, token = ownerToken) {
    const supplier = await createTestSupplier(targetBusinessId, { email: supplierEmail });
    const product = await createTestProduct(targetBusinessId, { costPrice: 10 });

    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ supplierId: supplier.id, branchId, items: [{ productId: product.id, quantityOrdered: 5, unitCostSnapshot: 10 }] });
    const po = createRes.body.data;

    const sendRes = await request(app)
      .post(`/purchase-orders/${po.id}/send`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: po.version });

    await request(app)
      .post(`/purchase-orders/${sendRes.body.data.id}/secure-link/regenerate`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey());

    const fresh = await prisma.purchase_orders.findUniqueOrThrow({ where: { id: sendRes.body.data.id } });
    return { po: fresh, supplier };
  }

  function postWebhook(payload: unknown, secret = WEBHOOK_SECRET) {
    const { body, headers } = signWebhookPayload(payload, secret);
    return request(app)
      .post("/api/webhooks/resend-inbound")
      .set("Content-Type", "application/json")
      .set(headers)
      .send(body);
  }

  describe("Signature verification (Lock #6)", () => {
    it("rejects a request with an invalid signature -- 401, no message, no quarantine row", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      const payload = emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] });

      const res = await postWebhook(payload, WRONG_SECRET);

      expect(res.status).toBe(401);
      const messages = await prisma.po_negotiation_messages.count({ where: { purchase_order_id: po.id, resend_email_id: emailId } });
      expect(messages).toBe(0);
      const unmatched = await prisma.unmatched_inbound_emails.count({ where: { resend_email_id: emailId } });
      expect(unmatched).toBe(0);
    });

    it("rejects a request with missing signature headers -- 401", async () => {
      const payload = emailReceivedPayload({ emailId: `email-${randomUUID()}`, from: "x@y.test", to: ["po-doesnotmatter@test.resend.app"] });
      const res = await request(app).post("/api/webhooks/resend-inbound").set("Content-Type", "application/json").send(JSON.stringify(payload));
      expect(res.status).toBe(401);
    });

    it("never exposes internal error detail in the 401 response", async () => {
      const payload = emailReceivedPayload({ emailId: `email-${randomUUID()}`, from: "x@y.test", to: ["po-x@test.resend.app"] });
      const res = await postWebhook(payload, WRONG_SECRET);
      expect(JSON.stringify(res.body)).not.toMatch(/RESEND_WEBHOOK_SECRET|stack|prisma/i);
    });
  });

  describe("Thread matching (Lock #2) -- deterministic reply-to token only, never subject", () => {
    it("matches and creates a message when the reply-to token resolves to exactly one PO", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplier.email!,
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Re: PO",
        text: "This is the supplier's reply text.",
        attachments: [],
      });

      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] })
      );

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("message_created");
      const message = await prisma.po_negotiation_messages.findFirst({ where: { resend_email_id: emailId } });
      expect(message).not.toBeNull();
      expect(message?.purchase_order_id).toBe(po.id);
      expect(message?.source).toBe("email");
      expect(message?.sender_type).toBe("supplier");
    });

    it("subject alone is never sufficient -- a changed subject with the correct correlation token still matches", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplier.email!,
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Completely unrelated subject line",
        text: "This is the supplier's reply text.",
        attachments: [],
      });

      const res = await postWebhook(
        emailReceivedPayload({
          emailId,
          from: supplier.email!,
          to: [`po-${po.negotiation_reply_token}@test.resend.app`],
          subject: "Completely unrelated subject line",
        })
      );

      expect(res.body.outcome).toBe("message_created");
    });

    it("the same subject across two different POs never causes a cross-match -- each resolves only via its own token", async () => {
      const first = await createSentPoWithReplyToken();
      const second = await createSentPoWithReplyToken();
      const sharedSubject = "Purchase Order Update";
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: first.supplier.email!,
        to: [`po-${first.po.negotiation_reply_token}@test.resend.app`],
        subject: sharedSubject,
        text: "This is the supplier's reply text.",
        attachments: [],
      });

      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: first.supplier.email!, to: [`po-${first.po.negotiation_reply_token}@test.resend.app`], subject: sharedSubject })
      );

      expect(res.body.outcome).toBe("message_created");
      const message = await prisma.po_negotiation_messages.findFirst({ where: { resend_email_id: emailId } });
      expect(message?.purchase_order_id).toBe(first.po.id);
      expect(message?.purchase_order_id).not.toBe(second.po.id);
    });

    it("quarantines as thread_not_found when the reply-to token doesn't match any PO", async () => {
      const emailId = `email-${randomUUID()}`;
      const res = await postWebhook(emailReceivedPayload({ emailId, from: "nobody@example.test", to: [`po-${"a".repeat(48)}@test.resend.app`] }));

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("quarantined");
      const row = await prisma.unmatched_inbound_emails.findUnique({ where: { resend_email_id: emailId } });
      expect(row?.reason).toBe("thread_not_found");
      expect(row?.business_id).toBeNull();
    });

    it("quarantines as thread_not_found when the `to` address doesn't even look like a correlation address", async () => {
      const emailId = `email-${randomUUID()}`;
      const res = await postWebhook(emailReceivedPayload({ emailId, from: "nobody@example.test", to: ["random@somewhere.test"] }));

      expect(res.body.outcome).toBe("quarantined");
      const row = await prisma.unmatched_inbound_emails.findUnique({ where: { resend_email_id: emailId } });
      expect(row?.reason).toBe("thread_not_found");
    });

    it("quarantines as thread_not_found when the matched PO's negotiation is no longer open (e.g. already confirmed)", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      await request(app)
        .post(`/purchase-orders/${po.id}/confirm`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: po.version });

      const emailId = `email-${randomUUID()}`;
      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] })
      );

      expect(res.body.outcome).toBe("quarantined");
      const row = await prisma.unmatched_inbound_emails.findUnique({ where: { resend_email_id: emailId } });
      expect(row?.reason).toBe("thread_not_found");
    });
  });

  describe("Tenant isolation (Lock #1)", () => {
    it("a token that genuinely belongs to Business A can never attach a message to a PO under a different lookup -- resolution is scoped by construction", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);
      const otherBranch = await createTestBranch(other.businessId);

      const { po: poA } = await createSentPoWithReplyToken(undefined, businessId, ownerToken);

      // A second, unrelated PO in a completely different business.
      const supplierB = await createTestSupplier(other.businessId, { email: `supplierB-${randomUUID()}@example.test` });
      const productB = await createTestProduct(other.businessId, { costPrice: 5 });
      const createResB = await request(app)
        .post("/purchase-orders")
        .set("Authorization", `Bearer ${otherLogin.accessToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ supplierId: supplierB.id, branchId: otherBranch.id, items: [{ productId: productB.id, quantityOrdered: 1, unitCostSnapshot: 5 }] });

      // Attempt to reply using PO A's own token, but claiming to be
      // supplier B's from-address and addressed as if for business B's PO.
      const emailId = `email-${randomUUID()}`;
      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: supplierB.email!, to: [`po-${poA.negotiation_reply_token}@test.resend.app`] })
      );

      // The token only ever resolves to PO A (its OWN business) -- supplier
      // B's from-address doesn't match PO A's own supplier_email_snapshot,
      // so this is correctly rejected as sender_not_recognized, never
      // silently attached to PO A under the wrong supplier, and never
      // attached to business B's own (unrelated, un-tokened) PO either.
      expect(res.body.outcome).toBe("quarantined");
      const row = await prisma.unmatched_inbound_emails.findUnique({ where: { resend_email_id: emailId } });
      expect(row?.reason).toBe("sender_not_recognized");
      expect(row?.business_id).toBe(businessId);

      const messagesOnA = await prisma.po_negotiation_messages.count({ where: { purchase_order_id: poA.id, resend_email_id: emailId } });
      expect(messagesOnA).toBe(0);
      void createResB;
    });

    it("cannot create a negotiation message under another tenant's business_id even with a syntactically valid but foreign correlation token", async () => {
      const other = await signupTestOwner();
      businessIds.push(other.businessId);

      // A token that was never actually issued to any PO in any business.
      const fabricatedToken = "f".repeat(48);
      const emailId = `email-${randomUUID()}`;
      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: "attacker@example.test", to: [`po-${fabricatedToken}@test.resend.app`] })
      );

      expect(res.body.outcome).toBe("quarantined");
      const messages = await prisma.po_negotiation_messages.count({ where: { business_id: other.businessId, resend_email_id: emailId } });
      expect(messages).toBe(0);
    });
  });

  describe("Sender verification (Lock #3)", () => {
    it("quarantines as sender_not_recognized when the from-address doesn't match the matched PO's own supplier_email_snapshot", async () => {
      const { po } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: "someone-else@example.test", to: [`po-${po.negotiation_reply_token}@test.resend.app`] })
      );

      expect(res.body.outcome).toBe("quarantined");
      const row = await prisma.unmatched_inbound_emails.findUnique({ where: { resend_email_id: emailId } });
      expect(row?.reason).toBe("sender_not_recognized");
      expect(row?.business_id).toBe(businessId);
    });

    it("accepts a matching sender case-insensitively (real mail clients vary case)", async () => {
      const supplierEmail = `Case-Sensitive-${randomUUID()}@Example.test`;
      const { po } = await createSentPoWithReplyToken(supplierEmail);
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplierEmail.toUpperCase(),
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Re: PO",
        text: "This is the supplier's reply text.",
        attachments: [],
      });

      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: supplierEmail.toUpperCase(), to: [`po-${po.negotiation_reply_token}@test.resend.app`] })
      );

      expect(res.body.outcome).toBe("message_created");
    });

    it("quarantines when the sender matches a DIFFERENT real, known supplier (same business) but not the one on this PO", async () => {
      const { po } = await createSentPoWithReplyToken();
      const otherSupplier = await createTestSupplier(businessId, { email: `unrelated-${randomUUID()}@example.test` });

      const emailId = `email-${randomUUID()}`;
      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: otherSupplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] })
      );

      expect(res.body.outcome).toBe("quarantined");
      const row = await prisma.unmatched_inbound_emails.findUnique({ where: { resend_email_id: emailId } });
      expect(row?.reason).toBe("sender_not_recognized");
    });
  });

  describe("Idempotency (Lock #5) -- transaction-safe, database-enforced", () => {
    it("processing the same resend_email_id twice, sequentially, results in exactly one message", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplier.email!,
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Re: PO",
        text: "This is the supplier's reply text.",
        attachments: [],
      });
      const payload = emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] });

      const first = await postWebhook(payload);
      const second = await postWebhook(payload);

      expect(first.body.outcome).toBe("message_created");
      expect(second.body.outcome).toBe("already_processed");
      const count = await prisma.po_negotiation_messages.count({ where: { resend_email_id: emailId } });
      expect(count).toBe(1);
    });

    it("two concurrent deliveries of the same resend_email_id produce exactly one negotiation message (real concurrency, not simulated)", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplier.email!,
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Re: PO",
        text: "This is the supplier's reply text.",
        attachments: [],
      });
      const payload = emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] });

      const [r1, r2] = await Promise.all([postWebhook(payload), postWebhook(payload)]);

      const outcomes = [r1.body.outcome, r2.body.outcome].sort();
      expect(outcomes).toEqual(["already_processed", "message_created"]);
      const count = await prisma.po_negotiation_messages.count({ where: { resend_email_id: emailId } });
      expect(count).toBe(1);
    });
  });

  describe("Attachment security (Lock #4)", () => {
    it("a valid attachment is validated, registered via StorageProvider, and linked to the created message", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplier.email!,
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Re: PO",
        text: "This is the supplier's reply text.",
        attachments: [{ id: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1024 }],
      });

      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] })
      );

      expect(res.body.outcome).toBe("message_created");
      expect(spyStorageProvider.registered).toHaveLength(1);
      expect(spyStorageProvider.registered[0].fileName).toBe("invoice.pdf");
      expect(spyStorageProvider.registered[0].mimeType).toBe("application/pdf");
      expect(spyStorageProvider.registered[0].businessId).toBe(businessId);

      const message = await prisma.po_negotiation_messages.findFirstOrThrow({ where: { resend_email_id: emailId } });
      const attachments = await prisma.po_negotiation_attachments.findMany({ where: { message_id: message.id } });
      expect(attachments).toHaveLength(1);
      expect(attachments[0].file_name).toBe("invoice.pdf");
      expect(attachments[0].purchase_order_id).toBe(po.id);
      expect(attachments[0].business_id).toBe(businessId);
    });

    it("an oversized attachment is rejected safely -- skipped, message still created without it", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplier.email!,
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Re: PO",
        text: "This is the supplier's reply text.",
        attachments: [{ id: "att-big", filename: "huge.pdf", mimeType: "application/pdf", sizeBytes: 20 * 1024 * 1024 }],
      });

      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] })
      );

      expect(res.body.outcome).toBe("message_created");
      expect(spyStorageProvider.registered).toHaveLength(0);
      const message = await prisma.po_negotiation_messages.findFirstOrThrow({ where: { resend_email_id: emailId } });
      const attachments = await prisma.po_negotiation_attachments.findMany({ where: { message_id: message.id } });
      expect(attachments).toHaveLength(0);
    });

    it("an unsupported attachment type is rejected safely -- skipped, message still created without it", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplier.email!,
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Re: PO",
        text: "This is the supplier's reply text.",
        attachments: [{ id: "att-exe", filename: "installer.exe", mimeType: "application/x-msdownload", sizeBytes: 1024 }],
      });

      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] })
      );

      expect(res.body.outcome).toBe("message_created");
      expect(spyStorageProvider.registered).toHaveLength(0);
    });

    it("a filename with a path-traversal attempt is sanitized before storage", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplier.email!,
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Re: PO",
        text: "This is the supplier's reply text.",
        attachments: [{ id: "att-trav", filename: "../../../etc/passwd.pdf", mimeType: "application/pdf", sizeBytes: 512 }],
      });

      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] })
      );

      expect(res.body.outcome).toBe("message_created");
      expect(spyStorageProvider.registered).toHaveLength(1);
      expect(spyStorageProvider.registered[0].fileName).not.toContain("..");
      expect(spyStorageProvider.registered[0].fileName).not.toContain("/");
    });

    it("the storage key never derives from the filename -- always Resend's own opaque ids", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplier.email!,
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Re: PO",
        text: "This is the supplier's reply text.",
        attachments: [{ id: "att-key-check", filename: "../weird name!!.pdf", mimeType: "application/pdf", sizeBytes: 512 }],
      });

      await postWebhook(emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] }));

      expect(spyStorageProvider.registered[0].clientStorageKey).toBe(`resend-inbound:${emailId}:att-key-check`);
    });
  });

  describe("Failure safety (Lock #6) -- malformed/hostile input", () => {
    it("a malformed payload (missing from/to) never creates a message and the handler doesn't crash", async () => {
      const { body, headers } = signWebhookPayload({ type: "email.received", data: { email_id: `email-${randomUUID()}` } }, WEBHOOK_SECRET);
      const res = await request(app).post("/api/webhooks/resend-inbound").set("Content-Type", "application/json").set(headers).send(body);

      expect(res.status).toBe(200); // acknowledged so Resend doesn't retry a payload we'll never parse
      expect(res.body.received).toBe(true);
    });

    it("a non-email.received event type is a real no-op, never an error", async () => {
      const res = await postWebhook({ type: "email.sent", created_at: new Date().toISOString(), data: { email_id: "x", from: "a@b.c", to: ["d@e.f"], subject: "s" } });
      expect(res.status).toBe(200);
      expect(res.body.ignored).toBe(true);
    });

    it("an entirely garbage (but validly signed) body doesn't crash the handler", async () => {
      const { body, headers } = signWebhookPayload({ not: "a valid envelope at all" }, WEBHOOK_SECRET);
      const res = await request(app).post("/api/webhooks/resend-inbound").set("Content-Type", "application/json").set(headers).send(body);
      expect(res.status).toBe(200);
    });

    it("getReceivedEmail failing (returns null) quarantines as parse_error rather than crashing", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      // Deliberately NOT programmed into spyEmailProvider.receivedEmails --
      // getReceivedEmail() will return null, simulating a Resend API failure.
      const res = await postWebhook(
        emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] })
      );

      expect(res.body.outcome).toBe("quarantined");
      const row = await prisma.unmatched_inbound_emails.findUnique({ where: { resend_email_id: emailId } });
      expect(row?.reason).toBe("parse_error");
    });
  });

  describe("isolates negotiation messages across businesses (a reply can never surface on the wrong tenant's timeline)", () => {
    it("a message created via inbound email is only ever visible under its own business's PO", async () => {
      const { po, supplier } = await createSentPoWithReplyToken();
      const emailId = `email-${randomUUID()}`;
      spyEmailProvider.receivedEmails.set(emailId, {
        emailId,
        from: supplier.email!,
        to: [`po-${po.negotiation_reply_token}@test.resend.app`],
        subject: "Re: PO",
        text: "This is the supplier's reply text.",
        attachments: [],
      });
      await postWebhook(emailReceivedPayload({ emailId, from: supplier.email!, to: [`po-${po.negotiation_reply_token}@test.resend.app`] }));

      const other = await signupTestOwner();
      businessIds.push(other.businessId);
      const otherLogin = await loginTestOwner(other.email, other.password, other.deviceId);

      const res = await request(app)
        .get(`/purchase-orders/${po.id}/negotiation/messages`)
        .set("Authorization", `Bearer ${otherLogin.accessToken}`);
      expect(res.status).toBe(404);
    });
  });
});

describe("GET /api/unmatched-inbound-emails -- review endpoint", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;

    setEmailProvider(new SpyEmailProvider(), "spy");
    const branch = await createTestBranch(businessId);
    const supplier = await createTestSupplier(businessId, { email: `supplier-${randomUUID()}@example.test` });
    const product = await createTestProduct(businessId, { costPrice: 10 });
    const createRes = await request(app)
      .post("/purchase-orders")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", `test-${randomUUID()}`)
      .send({ supplierId: supplier.id, branchId: branch.id, items: [{ productId: product.id, quantityOrdered: 1, unitCostSnapshot: 10 }] });
    const sendRes = await request(app)
      .post(`/purchase-orders/${createRes.body.data.id}/send`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", `test-${randomUUID()}`)
      .send({ version: createRes.body.data.version });
    await request(app)
      .post(`/purchase-orders/${sendRes.body.data.id}/secure-link/regenerate`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", `test-${randomUUID()}`);
    const po = await prisma.purchase_orders.findUniqueOrThrow({ where: { id: sendRes.body.data.id } });

    // Generate one real quarantined row via the actual webhook path.
    const emailId = `email-${randomUUID()}`;
    const payload = emailReceivedPayload({ emailId, from: "unknown@somewhere.test", to: [`po-${po.negotiation_reply_token}@test.resend.app`] });
    const { body, headers } = signWebhookPayload(payload, env.RESEND_WEBHOOK_SECRET!);
    await request(app).post("/api/webhooks/resend-inbound").set("Content-Type", "application/json").set(headers).send(body);

    setEmailProvider(new ConsoleEmailProvider(), "console");
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  describe("RBAC", () => {
    const cases: { role: UserRole; canView: boolean }[] = [
      { role: "owner", canView: true },
      { role: "manager", canView: true },
      { role: "accountant", canView: false },
      { role: "storekeeper", canView: false },
      { role: "cashier", canView: false },
      { role: "shareholder", canView: false },
      { role: "custom", canView: false },
      { role: "super_admin", canView: true },
    ];

    it.each(cases)("role=$role canView=$canView", async ({ role, canView }) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).get("/api/unmatched-inbound-emails").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(canView ? 200 : 403);
    });
  });

  it("returns a paginated {data, pagination} envelope scoped to the caller's own business", async () => {
    const res = await request(app).get("/api/unmatched-inbound-emails").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.pagination).toBeDefined();
    for (const row of res.body.data) {
      expect(row.business_id).toBe(businessId);
    }
  });

  it("returns 401 with no token", async () => {
    const res = await request(app).get("/api/unmatched-inbound-emails");
    expect(res.status).toBe(401);
  });
});
