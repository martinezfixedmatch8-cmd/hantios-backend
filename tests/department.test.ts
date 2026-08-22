import request from "supertest";
import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken } from "./helpers/factories";

// Batch 6 (HNT2-HR-001) -- Departments gain a full lifecycle (get/update/
// archive/restore) plus a real active-only, whitespace/case-normalized
// uniqueness guarantee, on top of the create/list-only shape Module 12
// Session A originally shipped.
describe("Departments (HNT2-HR-001)", () => {
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

  async function createDepartment(token = ownerToken, name = `Finance ${randomUUID()}`, key = idemKey()) {
    return request(app).post("/departments").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ name });
  }

  it("returns 401 with no token", async () => {
    const res = await request(app).get("/departments");
    expect(res.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await request(app).post("/departments").set("Authorization", `Bearer ${ownerToken}`).send({ name: `NoKey ${randomUUID()}` });
    expect(res.status).toBe(400);
  });

  it("returns 403 for a cashier (not owner/manager)", async () => {
    const cashier = await createTestUser(businessId, "cashier");
    const token = mintAccessToken(cashier);
    const res = await createDepartment(token);
    expect(res.status).toBe(403);
  });

  it("creates, lists, gets, updates, archives, and restores a department (full lifecycle)", async () => {
    const name = `Operations ${randomUUID()}`;
    const createRes = await createDepartment(ownerToken, name);
    expect(createRes.status).toBe(201);
    const id = createRes.body.data.id;
    expect(createRes.body.data).toMatchObject({ name, status: "active", version: 0 });

    const auditRows = await prisma.audit_logs.findMany({ where: { entity_id: id, action: "department.created" } });
    expect(auditRows).toHaveLength(1);

    const listRes = await request(app).get("/departments").query({ search: name }).set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((d: { id: string }) => d.id === id)).toBe(true);

    const getRes = await request(app).get(`/departments/${id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.id).toBe(id);

    const newName = `Operations Renamed ${randomUUID()}`;
    const updateRes = await request(app)
      .patch(`/departments/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: newName, version: 0 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.name).toBe(newName);
    expect(updateRes.body.data.version).toBe(1);

    const archiveRes = await request(app)
      .post(`/departments/${id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 1 });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.status).toBe("archived");

    // Already-archived is a successful no-op, not a 400.
    const archiveAgainRes = await request(app)
      .post(`/departments/${id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 99 });
    expect(archiveAgainRes.status).toBe(200);
    expect(archiveAgainRes.body.data.status).toBe("archived");

    const restoreRes = await request(app)
      .post(`/departments/${id}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 2 });
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.status).toBe("active");

    const restoreAgainRes = await request(app)
      .post(`/departments/${id}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 99 });
    expect(restoreAgainRes.status).toBe(200);
    expect(restoreAgainRes.body.data.status).toBe("active");
  });

  it("idempotent replay: the same key returns the original response and creates exactly one department", async () => {
    const key = idemKey();
    const name = `Replay ${randomUUID()}`;
    const first = await createDepartment(ownerToken, name, key);
    expect(first.status).toBe(201);
    const second = await createDepartment(ownerToken, name, key);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const rows = await prisma.departments.findMany({ where: { business_id: businessId, name } });
    expect(rows).toHaveLength(1);
  });

  it("returns 409 for a stale version on update/archive/restore", async () => {
    const createRes = await createDepartment();
    const id = createRes.body.data.id;

    const updateRes = await request(app)
      .patch(`/departments/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "x", version: 99 });
    expect(updateRes.status).toBe(409);

    const archiveRes = await request(app)
      .post(`/departments/${id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 99 });
    expect(archiveRes.status).toBe(409);
  });

  describe("active-only, normalized name uniqueness", () => {
    // Transform functions applied directly to a freshly-generated unique
    // base name (never a fixed pattern string) -- guarantees each variant's
    // collision target actually contains that exact base, so the test can
    // never silently no-op the way a case/whitespace-sensitive
    // String.replace() against a literal search string would (that was the
    // original, real bug here: replace("Finance Manager", base) only ever
    // matched the exact-case, single-space literal, silently leaving every
    // other variant unchanged and not colliding with anything).
    const variantTransforms: Array<[string, (base: string) => string]> = [
      ["uppercase", (base) => base.toUpperCase()],
      ["surrounded by extra whitespace", (base) => `  ${base}  `],
      ["internal run of spaces", (base) => base.replace(" ", "   ")],
      ["internal tab instead of space", (base) => base.replace(" ", "\t")],
    ];

    it.each(variantTransforms)("rejects a normalized-duplicate name variant: %s", async (_label, transform) => {
      const base = `Finance Manager ${randomUUID()}`;
      const first = await createDepartment(ownerToken, base);
      expect(first.status).toBe(201);

      const second = await createDepartment(ownerToken, transform(base));
      expect(second.status).toBe(400);
    });

    it("allows a new department to reuse a normalized name held only by an archived department", async () => {
      const name = `ReuseAfterArchive ${randomUUID()}`;
      const first = await createDepartment(ownerToken, name);
      await request(app)
        .post(`/departments/${first.body.data.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0 });

      const second = await createDepartment(ownerToken, `  ${name.toUpperCase()}  `);
      expect(second.status).toBe(201);
      expect(second.body.data.id).not.toBe(first.body.data.id);
    });

    it("returns 409 restoring a department whose normalized name a different active department has since claimed", async () => {
      const name = `ClaimedWhileArchived ${randomUUID()}`;
      const original = await createDepartment(ownerToken, name);
      await request(app)
        .post(`/departments/${original.body.data.id}/archive`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 0 });

      const replacement = await createDepartment(ownerToken, name);
      expect(replacement.status).toBe(201);

      const restoreRes = await request(app)
        .post(`/departments/${original.body.data.id}/restore`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", idemKey())
        .send({ version: 1 });
      expect(restoreRes.status).toBe(409);
    });

    it("under real concurrency, exactly one of two simultaneous creates with the same normalized name succeeds", async () => {
      const name = `ConcurrentCollision ${randomUUID()}`;
      const [a, b] = await Promise.all([
        createDepartment(ownerToken, name.toUpperCase()),
        createDepartment(ownerToken, `  ${name}  `),
      ]);
      // Array.prototype.sort() with no comparator sorts as strings --
      // "201" < "400"/"409" lexicographically (both start with a smaller
      // leading digit), so the winning 201 always sorts to index 0, not 1.
      const statuses = [a.status, b.status].sort();
      // Either app-layer pre-check (400) or the real partial unique index
      // (409) may catch the loser depending on timing -- both correctly
      // reject it, only one side ever wins.
      const successes = [a, b].filter((r) => r.status === 201);
      expect(successes).toHaveLength(1);
      expect(statuses[0]).toBe(201);
      expect([400, 409]).toContain(statuses[1]);

      const rows = await prisma.departments.findMany({ where: { business_id: businessId, status: "active" } });
      const normalized = rows.map((r) => r.name.trim().replace(/\s+/g, " ").toLowerCase());
      const dupeCount = normalized.filter((n) => n === name.trim().toLowerCase()).length;
      expect(dupeCount).toBe(1);
    });
  });

  it("isolates departments across businesses (404, not a data leak)", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
    const otherDept = await createDepartment(otherLogin.accessToken, `OtherBiz ${randomUUID()}`);

    const getRes = await request(app).get(`/departments/${otherDept.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(404);

    const updateRes = await request(app)
      .patch(`/departments/${otherDept.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Hijacked", version: 0 });
    expect(updateRes.status).toBe(404);

    const archiveRes = await request(app)
      .post(`/departments/${otherDept.body.data.id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 0 });
    expect(archiveRes.status).toBe(404);
  });

  describe("permission matrix", () => {
    const deniedCreate: UserRole[] = ["accountant", "cashier", "storekeeper", "shareholder", "custom"];
    const deniedRead: UserRole[] = ["cashier", "storekeeper", "shareholder", "custom"];

    it.each(deniedCreate)("denies role=%s creating a department", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await createDepartment(token, `Denied ${randomUUID()}`);
      expect(res.status).toBe(403);
    });

    it.each(deniedRead)("denies role=%s listing departments", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).get("/departments").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("allows manager to create and accountant to list but not create", async () => {
      const manager = await createTestUser(businessId, "manager");
      const managerToken = mintAccessToken(manager);
      const createRes = await createDepartment(managerToken, `Manager Dept ${randomUUID()}`);
      expect(createRes.status).toBe(201);

      const accountant = await createTestUser(businessId, "accountant");
      const accountantToken = mintAccessToken(accountant);
      const listRes = await request(app).get("/departments").set("Authorization", `Bearer ${accountantToken}`);
      expect(listRes.status).toBe(200);
      const accountantCreateRes = await createDepartment(accountantToken, `x ${randomUUID()}`);
      expect(accountantCreateRes.status).toBe(403);
    });

    it("allows super_admin to create and list regardless of role restrictions", async () => {
      const admin = await createTestUser(businessId, "super_admin");
      const token = mintAccessToken(admin);
      const createRes = await createDepartment(token, `Admin Dept ${randomUUID()}`);
      expect(createRes.status).toBe(201);
      const listRes = await request(app).get("/departments").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(200);
    });
  });
});
