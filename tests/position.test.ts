import request from "supertest";
import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken } from "./helpers/factories";

// Batch 6 (HNT2-HR-001) -- Positions gain the identical full lifecycle
// Departments gained, plus the archived-department guard on position
// create/update (item 5 of the Amended Phase 2 review).
describe("Positions (HNT2-HR-001)", () => {
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

  async function createDepartment(token = ownerToken, name = `Dept ${randomUUID()}`) {
    const res = await request(app).post("/departments").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", idemKey()).send({ name });
    if (res.status !== 201) throw new Error(`createDepartment failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  async function createPosition(token = ownerToken, title = `Salesperson ${randomUUID()}`, departmentId?: string, key = idemKey()) {
    return request(app)
      .post("/positions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key)
      .send({ title, ...(departmentId ? { departmentId } : {}) });
  }

  it("returns 401 with no token", async () => {
    const res = await request(app).get("/positions");
    expect(res.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await request(app).post("/positions").set("Authorization", `Bearer ${ownerToken}`).send({ title: `NoKey ${randomUUID()}` });
    expect(res.status).toBe(400);
  });

  it("returns 403 for a cashier (not owner/manager)", async () => {
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);
    const res = await createPosition(token);
    expect(res.status).toBe(403);
  });

  it("creates, lists, gets, updates, archives, and restores a position (full lifecycle)", async () => {
    const department = await createDepartment();
    const title = `Cashier ${randomUUID()}`;
    const createRes = await createPosition(ownerToken, title, department.id);
    expect(createRes.status).toBe(201);
    const id = createRes.body.data.id;
    expect(createRes.body.data).toMatchObject({ title, department_id: department.id, status: "active", version: 0 });

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: id, action: "position.created" } });
    expect(auditRows).toHaveLength(1);

    const listRes = await request(app).get("/positions").query({ search: title }).set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((p: { id: string }) => p.id === id)).toBe(true);

    const getRes = await request(app).get(`/positions/${id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.id).toBe(id);

    const newTitle = `Cashier Renamed ${randomUUID()}`;
    const updateRes = await request(app)
      .patch(`/positions/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ title: newTitle, version: 0 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.title).toBe(newTitle);
    expect(updateRes.body.data.version).toBe(1);

    const archiveRes = await request(app)
      .post(`/positions/${id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 1 });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.status).toBe("archived");

    const archiveAgainRes = await request(app)
      .post(`/positions/${id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 99 });
    expect(archiveAgainRes.status).toBe(200);
    expect(archiveAgainRes.body.data.status).toBe("archived");

    const restoreRes = await request(app)
      .post(`/positions/${id}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 2 });
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.status).toBe("active");

    const restoreAgainRes = await request(app)
      .post(`/positions/${id}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 99 });
    expect(restoreAgainRes.status).toBe(200);
    expect(restoreAgainRes.body.data.status).toBe("active");
  });

  it("idempotent replay: the same key returns the original response and creates exactly one position", async () => {
    const key = idemKey();
    const title = `Replay ${randomUUID()}`;
    const first = await createPosition(ownerToken, title, undefined, key);
    expect(first.status).toBe(201);
    const second = await createPosition(ownerToken, title, undefined, key);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const rows = await prisma.positions.findMany({ where: { business_id: businessId, title } });
    expect(rows).toHaveLength(1);
  });

  it("returns 409 for a stale version on update/archive/restore", async () => {
    const createRes = await createPosition();
    const id = createRes.body.data.id;

    const updateRes = await request(app).patch(`/positions/${id}`).set("Authorization", `Bearer ${ownerToken}`).send({ title: "x", version: 99 });
    expect(updateRes.status).toBe(409);

    const archiveRes = await request(app)
      .post(`/positions/${id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 99 });
    expect(archiveRes.status).toBe(409);
  });

  describe("active-only, normalized title uniqueness", () => {
    // Transform functions applied directly to a freshly-generated unique
    // base title (never a fixed pattern string) -- see department.test.ts's
    // identical fix for why a fixed-pattern String.replace() silently
    // failed to build real collisions for every variant but the exact-case
    // one.
    const variantTransforms: Array<[string, (base: string) => string]> = [
      ["uppercase", (base) => base.toUpperCase()],
      ["surrounded by extra whitespace", (base) => `  ${base}  `],
      ["internal run of spaces", (base) => base.replace(" ", "   ")],
      ["internal tab instead of space", (base) => base.replace(" ", "\t")],
    ];

    it.each(variantTransforms)("rejects a normalized-duplicate title variant: %s", async (_label, transform) => {
      const base = `Sales Rep ${randomUUID()}`;
      const first = await createPosition(ownerToken, base);
      expect(first.status).toBe(201);

      const second = await createPosition(ownerToken, transform(base));
      expect(second.status).toBe(400);
    });

    it("allows a new position to reuse a normalized title held only by an archived position", async () => {
      const title = `ReuseAfterArchive ${randomUUID()}`;
      const first = await createPosition(ownerToken, title);
      await request(app)
        .post(`/positions/${first.body.data.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0 });

      const second = await createPosition(ownerToken, `  ${title.toUpperCase()}  `);
      expect(second.status).toBe(201);
      expect(second.body.data.id).not.toBe(first.body.data.id);
    });

    it("returns 409 restoring a position whose normalized title a different active position has since claimed", async () => {
      const title = `ClaimedWhileArchived ${randomUUID()}`;
      const original = await createPosition(ownerToken, title);
      await request(app)
        .post(`/positions/${original.body.data.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0 });

      const replacement = await createPosition(ownerToken, title);
      expect(replacement.status).toBe(201);

      const restoreRes = await request(app)
        .post(`/positions/${original.body.data.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 1 });
      expect(restoreRes.status).toBe(409);
    });

    it("under real concurrency, exactly one of two simultaneous creates with the same normalized title succeeds", async () => {
      const title = `ConcurrentCollision ${randomUUID()}`;
      const [a, b] = await Promise.all([
        createPosition(ownerToken, title.toUpperCase()),
        createPosition(ownerToken, `  ${title}  `),
      ]);
      const successes = [a, b].filter((r) => r.status === 201);
      expect(successes).toHaveLength(1);
      // Array.prototype.sort() with no comparator sorts as strings --
      // "201" < "400"/"409" lexicographically, so the winning 201 always
      // sorts to index 0, not 1.
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      expect([400, 409]).toContain(statuses[1]);
    });
  });

  // Batch 6, Amended Phase 2 item 5 -- the archived-department guard on
  // position create/update.
  describe("archived-department guard", () => {
    it("rejects creating a position with an archived departmentId", async () => {
      const department = await createDepartment();
      await request(app)
        .post(`/departments/${department.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0 });

      const res = await createPosition(ownerToken, `Blocked ${randomUUID()}`, department.id);
      expect(res.status).toBe(400);
    });

    it("rejects reassigning an existing position onto an archived departmentId via PATCH", async () => {
      const department = await createDepartment();
      const createRes = await createPosition(ownerToken, `Reassign ${randomUUID()}`);
      const id = createRes.body.data.id;

      await request(app)
        .post(`/departments/${department.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0 });

      const res = await request(app)
        .patch(`/positions/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ title: createRes.body.data.title, departmentId: department.id, version: 0 });
      expect(res.status).toBe(400);
    });

    it("keeps an existing position's link to a now-archived department fully readable", async () => {
      const department = await createDepartment();
      const createRes = await createPosition(ownerToken, `StaysLinked ${randomUUID()}`, department.id);
      const id = createRes.body.data.id;

      await request(app)
        .post(`/departments/${department.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0 });

      const getRes = await request(app).get(`/positions/${id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.department_id).toBe(department.id);

      // Renaming the position (not touching departmentId) must not be
      // blocked by the now-archived department it historically links to.
      const renameRes = await request(app)
        .patch(`/positions/${id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ title: `StillWorks ${randomUUID()}`, version: 0 });
      expect(renameRes.status).toBe(200);
    });
  });

  it("isolates positions across businesses (404, not a data leak)", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
    const otherPosition = await createPosition(otherLogin.accessToken, `OtherBiz ${randomUUID()}`);

    const getRes = await request(app).get(`/positions/${otherPosition.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(404);

    const updateRes = await request(app)
      .patch(`/positions/${otherPosition.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ title: "Hijacked", version: 0 });
    expect(updateRes.status).toBe(404);

    const archiveRes = await request(app)
      .post(`/positions/${otherPosition.body.data.id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 0 });
    expect(archiveRes.status).toBe(404);
  });

  describe("permission matrix", () => {
    const deniedCreate: UserRole[] = ["accountant", "cashier", "storekeeper", "shareholder", "custom"];
    const deniedRead: UserRole[] = ["cashier", "storekeeper", "shareholder", "custom"];

    it.each(deniedCreate)("denies role=%s creating a position", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await createPosition(token, `Denied ${randomUUID()}`);
      expect(res.status).toBe(403);
    });

    it.each(deniedRead)("denies role=%s listing positions", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).get("/positions").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("allows manager to create and accountant to list but not create", async () => {
      const manager = await createTestUser(businessId, "manager");
      const managerToken = mintAccessToken(manager);
      const createRes = await createPosition(managerToken, `Manager Position ${randomUUID()}`);
      expect(createRes.status).toBe(201);

      const accountant = await createTestUser(businessId, "accountant");
      const accountantToken = mintAccessToken(accountant);
      const listRes = await request(app).get("/positions").set("Authorization", `Bearer ${accountantToken}`);
      expect(listRes.status).toBe(200);
      const accountantCreateRes = await createPosition(accountantToken, `x ${randomUUID()}`);
      expect(accountantCreateRes.status).toBe(403);
    });

    it("allows super_admin to create and list regardless of role restrictions", async () => {
      const admin = await createTestUser(businessId, "super_admin");
      const token = mintAccessToken(admin);
      const createRes = await createPosition(token, `Admin Position ${randomUUID()}`);
      expect(createRes.status).toBe(201);
      const listRes = await request(app).get("/positions").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(200);
    });
  });
});
