import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { createTestInvite, signupTestOwner } from "./helpers/factories";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { SpyNotificationProvider } from "./helpers/notificationSpy";
import { setNotificationProvider } from "../src/notifications/registry";

const STRONG_PASSWORD = "Str0ng!Passw0rd";

describe("GET /staff/invite/:token and POST /staff/invite/:token/accept", () => {
  let businessId: string;
  let ownerId: string;
  let spy: SpyNotificationProvider;

  beforeAll(async () => {
    // Real signup now that Auth exists, rather than a directly-inserted owner row.
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    ownerId = owner.ownerId;
  });

  afterAll(async () => {
    await cleanupTestBusiness(businessId);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    spy = new SpyNotificationProvider();
    setNotificationProvider(spy);
  });

  describe("GET preview", () => {
    it("returns 404 for an unknown token", async () => {
      const res = await request(app).get("/staff/invite/does-not-exist");
      expect(res.status).toBe(404);
    });

    it("returns 410 for an expired invite", async () => {
      const invite = await createTestInvite(businessId, ownerId, {
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      const res = await request(app).get(`/staff/invite/${invite.token}`);
      expect(res.status).toBe(410);
    });

    it("returns 410 for a revoked invite", async () => {
      const invite = await createTestInvite(businessId, ownerId, { revokedAt: new Date() });
      const res = await request(app).get(`/staff/invite/${invite.token}`);
      expect(res.status).toBe(410);
    });

    it("returns 409 for an already-accepted invite", async () => {
      const invite = await createTestInvite(businessId, ownerId, { acceptedAt: new Date() });
      const res = await request(app).get(`/staff/invite/${invite.token}`);
      expect(res.status).toBe(409);
    });

    it("returns invite details on the happy path", async () => {
      const invite = await createTestInvite(businessId, ownerId, { role: "manager" });
      const res = await request(app).get(`/staff/invite/${invite.token}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ email: invite.email, role: "manager" });
      expect(res.body.data.businessName).toBeTruthy();
    });
  });

  describe("POST accept", () => {
    it("returns 400 for a weak password", async () => {
      const invite = await createTestInvite(businessId, ownerId);
      const res = await request(app)
        .post(`/staff/invite/${invite.token}/accept`)
        .send({ password: "weak", termsAccepted: true, privacyAccepted: true });
      expect(res.status).toBe(400);
    });

    it("returns 400 when terms/privacy are not accepted", async () => {
      const invite = await createTestInvite(businessId, ownerId);
      const res = await request(app)
        .post(`/staff/invite/${invite.token}/accept`)
        .send({ password: STRONG_PASSWORD, termsAccepted: false, privacyAccepted: true });
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown token", async () => {
      const res = await request(app)
        .post("/staff/invite/does-not-exist/accept")
        .send({ password: STRONG_PASSWORD, termsAccepted: true, privacyAccepted: true });
      expect(res.status).toBe(404);
    });

    it("returns 410 for an expired invite", async () => {
      const invite = await createTestInvite(businessId, ownerId, {
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      const res = await request(app)
        .post(`/staff/invite/${invite.token}/accept`)
        .send({ password: STRONG_PASSWORD, termsAccepted: true, privacyAccepted: true });
      expect(res.status).toBe(410);
    });

    it("activates the account on the happy path", async () => {
      const invite = await createTestInvite(businessId, ownerId, { role: "storekeeper" });

      const res = await request(app)
        .post(`/staff/invite/${invite.token}/accept`)
        .send({ password: STRONG_PASSWORD, termsAccepted: true, privacyAccepted: true });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ email: invite.email, role: "storekeeper" });

      const user = await prisma.users.findUnique({ where: { id: res.body.data.userId } });
      expect(user).not.toBeNull();
      expect(user?.status).toBe("active");
      expect(user?.activated_at).not.toBeNull();
      expect(user?.email_verified_at).not.toBeNull();
      expect(user?.terms_accepted_at).not.toBeNull();
      expect(user?.privacy_accepted_at).not.toBeNull();
      expect(user?.password_hash).not.toBeNull();

      const history = await prisma.password_history.findMany({ where: { user_id: user!.id } });
      expect(history).toHaveLength(1);

      const updatedInvite = await prisma.staff_invites.findUnique({ where: { id: invite.id } });
      expect(updatedInvite?.accepted_at).not.toBeNull();
      expect(updatedInvite?.user_id).toBe(user!.id);

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: user!.id, action: "staff_invite.accepted" } });
      expect(auditRows).toHaveLength(1);

      expect(spy.sent).toHaveLength(1);
      expect(spy.sent[0]).toMatchObject({ category: "TRANSACTIONAL", channel: "email", to: invite.email });
    });

    it("returns 409 when the same token is accepted a second time", async () => {
      const invite = await createTestInvite(businessId, ownerId);

      const first = await request(app)
        .post(`/staff/invite/${invite.token}/accept`)
        .send({ password: STRONG_PASSWORD, termsAccepted: true, privacyAccepted: true });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post(`/staff/invite/${invite.token}/accept`)
        .send({ password: STRONG_PASSWORD, termsAccepted: true, privacyAccepted: true });
      expect(second.status).toBe(409);
    });

    it("only lets one of two concurrent accepts win, with no 500 and no duplicate user", async () => {
      const invite = await createTestInvite(businessId, ownerId);
      const body = { password: STRONG_PASSWORD, termsAccepted: true, privacyAccepted: true };

      const [first, second] = await Promise.all([
        request(app).post(`/staff/invite/${invite.token}/accept`).send(body),
        request(app).post(`/staff/invite/${invite.token}/accept`).send(body),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const users = await prisma.users.findMany({ where: { email: invite.email } });
      expect(users).toHaveLength(1);
    });
  });
});
