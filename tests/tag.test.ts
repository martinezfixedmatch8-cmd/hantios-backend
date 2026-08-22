import request from "supertest";
import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken } from "./helpers/factories";

describe("Tags", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;
  let categoryId: string;

  const idemKey = () => `test-${randomUUID()}`;

  beforeAll(async () => {
    const owner = await signupTestOwner();
    businessId = owner.businessId;
    businessIds.push(businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);
    ownerToken = login.accessToken;

    const categories = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    categoryId = categories.body.data.find((c: { name: string }) => c.name === "Misc").id;
  });

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  async function createTag(token = ownerToken, name = `Travel ${randomUUID()}`, key = idemKey()) {
    return request(app).post("/tags").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ name });
  }

  const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  async function createExpenseWithTag(tagId: string) {
    const res = await request(app)
      .post("/expenses")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ scope: "business", categoryId, amount: 100, expenseDate: isoDate(-1), tagIds: [tagId] });
    if (res.status !== 201) throw new Error(`createExpenseWithTag failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  it("returns 401 with no token", async () => {
    const res = await request(app).get("/tags");
    expect(res.status).toBe(401);
  });

  // Batch 6 (HNT2-MASTER-001) -- create now requires Idempotency-Key.
  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await request(app).post("/tags").set("Authorization", `Bearer ${ownerToken}`).send({ name: `NoKey ${randomUUID()}` });
    expect(res.status).toBe(400);
  });

  it("lets owner/manager create a tag", async () => {
    const res = await createTag();
    expect(res.status).toBe(201);
    expect(res.body.data.business_id).toBe(businessId);
    expect(res.body.data).toMatchObject({ status: "active", version: 0 });

    const auditRows = await prisma.audit_logs.findMany({ where: { action: "tag.created", entity_id: res.body.data.id } });
    expect(auditRows).toHaveLength(1);
  });

  it("idempotent replay: the same key returns the original response and creates exactly one tag", async () => {
    const key = idemKey();
    const name = `Replay ${randomUUID()}`;
    const first = await createTag(ownerToken, name, key);
    expect(first.status).toBe(201);
    const second = await createTag(ownerToken, name, key);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const rows = await prisma.tags.findMany({ where: { business_id: businessId, name } });
    expect(rows).toHaveLength(1);
  });

  it("returns 400 for a duplicate tag name within the same business", async () => {
    const name = `Duplicate ${randomUUID()}`;
    const first = await createTag(ownerToken, name);
    expect(first.status).toBe(201);

    const second = await createTag(ownerToken, name);
    expect(second.status).toBe(400);
  });

  it("returns a {data, pagination} envelope on list", async () => {
    await createTag(ownerToken, `Listed ${randomUUID()}`);
    const res = await request(app).get("/tags?pageSize=1").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("pagination");
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });

  it("scopes tags per business -- a second business starts with none of the first business's tags", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);

    // Kept short -- tag names are capped at 50 chars (createTagSchema).
    const uniqueName = `OnlyFirstBiz ${randomUUID()}`;
    const createRes = await createTag(ownerToken, uniqueName);
    expect(createRes.status).toBe(201);

    const res = await request(app).get(`/tags?search=${encodeURIComponent(uniqueName)}`).set("Authorization", `Bearer ${otherLogin.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  // Batch 6 (HNT2-MASTER-001) -- get/rename.
  it("gets a single tag by id", async () => {
    const createRes = await createTag();
    const id = createRes.body.data.id;
    const res = await request(app).get(`/tags/${id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
  });

  it("renames a tag (version-guarded, no Idempotency-Key required)", async () => {
    const createRes = await createTag();
    const id = createRes.body.data.id;
    const newName = `Renamed ${randomUUID()}`;
    const res = await request(app).patch(`/tags/${id}`).set("Authorization", `Bearer ${ownerToken}`).send({ name: newName, version: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe(newName);
    expect(res.body.data.version).toBe(1);
  });

  it("returns 400 when renaming to a name already held by a different active tag", async () => {
    const nameA = `Active A ${randomUUID()}`;
    const nameB = `Active B ${randomUUID()}`;
    await createTag(ownerToken, nameA);
    const bRes = await createTag(ownerToken, nameB);

    const res = await request(app).patch(`/tags/${bRes.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`).send({ name: nameA, version: 0 });
    expect(res.status).toBe(400);
  });

  it("returns 409 for a stale version on rename/archive/restore", async () => {
    const createRes = await createTag();
    const id = createRes.body.data.id;

    const renameRes = await request(app).patch(`/tags/${id}`).set("Authorization", `Bearer ${ownerToken}`).send({ name: "x", version: 99 });
    expect(renameRes.status).toBe(409);

    const archiveRes = await request(app)
      .post(`/tags/${id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 99 });
    expect(archiveRes.status).toBe(409);
  });

  it("archives and restores a tag (idempotent no-op on repeat, not a 400)", async () => {
    const createRes = await createTag();
    const id = createRes.body.data.id;

    const archiveRes = await request(app)
      .post(`/tags/${id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 0 });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.status).toBe("archived");

    // Batch 6 -- already-archived is a successful no-op, not a 400.
    const archiveAgainRes = await request(app)
      .post(`/tags/${id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 5 });
    expect(archiveAgainRes.status).toBe(200);
    expect(archiveAgainRes.body.data.status).toBe("archived");

    const restoreRes = await request(app)
      .post(`/tags/${id}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 1 });
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.status).toBe("active");

    const restoreAgainRes = await request(app)
      .post(`/tags/${id}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 99 });
    expect(restoreAgainRes.status).toBe(200);
    expect(restoreAgainRes.body.data.status).toBe("active");
  });

  it("allows a new tag to reuse a name held only by an archived tag", async () => {
    // Kept short -- tag names are capped at 50 chars (createTagSchema), and
    // a 36-char randomUUID() leaves little room for a descriptive prefix.
    const name = `Reuse ${randomUUID()}`;
    const first = await createTag(ownerToken, name);
    expect(first.status).toBe(201);
    const archiveRes = await request(app)
      .post(`/tags/${first.body.data.id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 0 });
    expect(archiveRes.status).toBe(200);

    const second = await createTag(ownerToken, name);
    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  it("returns 409 restoring a tag whose name a different active tag has since claimed", async () => {
    // Kept short -- see the "reuse" test above for why (50-char cap).
    const name = `Claimed ${randomUUID()}`;
    const original = await createTag(ownerToken, name);
    expect(original.status).toBe(201);
    const archiveRes = await request(app)
      .post(`/tags/${original.body.data.id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 0 });
    expect(archiveRes.status).toBe(200);

    const replacement = await createTag(ownerToken, name);
    expect(replacement.status).toBe(201);

    const restoreRes = await request(app)
      .post(`/tags/${original.body.data.id}/restore`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 1 });
    expect(restoreRes.status).toBe(409);
  });

  it("filters by status=active/archived", async () => {
    const createRes = await createTag();
    const id = createRes.body.data.id;
    await request(app)
      .post(`/tags/${id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 0 });

    const archivedRes = await request(app).get(`/tags?status=archived&pageSize=100`).set("Authorization", `Bearer ${ownerToken}`);
    expect(archivedRes.body.data.some((t: { id: string }) => t.id === id)).toBe(true);

    const activeRes = await request(app).get(`/tags?status=active&pageSize=100`).set("Authorization", `Bearer ${ownerToken}`);
    expect(activeRes.body.data.some((t: { id: string }) => t.id === id)).toBe(false);
  });

  it("under real concurrency, exactly one of two simultaneous renames on the same tag succeeds", async () => {
    const createRes = await createTag();
    const id = createRes.body.data.id;

    const [a, b] = await Promise.all([
      request(app).patch(`/tags/${id}`).set("Authorization", `Bearer ${ownerToken}`).send({ name: `A ${randomUUID()}`, version: 0 }),
      request(app).patch(`/tags/${id}`).set("Authorization", `Bearer ${ownerToken}`).send({ name: `B ${randomUUID()}`, version: 0 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("keeps a historical expense-tag association readable after the tag is archived", async () => {
    const createRes = await createTag();
    const tagId = createRes.body.data.id;
    const expense = await createExpenseWithTag(tagId);

    await request(app)
      .post(`/tags/${tagId}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 0 });

    const getRes = await request(app).get(`/expenses/${expense.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
    const tagIds = (getRes.body.data.expense_tags as { tag_id: string }[]).map((t) => t.tag_id);
    expect(tagIds).toContain(tagId);
  });

  it("isolates tags across businesses (404, not a data leak)", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
    const otherTag = await createTag(otherLogin.accessToken, `OtherBiz ${randomUUID()}`);

    const getRes = await request(app).get(`/tags/${otherTag.body.data.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(404);

    const updateRes = await request(app)
      .patch(`/tags/${otherTag.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Hijacked", version: 0 });
    expect(updateRes.status).toBe(404);

    const archiveRes = await request(app)
      .post(`/tags/${otherTag.body.data.id}/archive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", idemKey())
      .send({ version: 0 });
    expect(archiveRes.status).toBe(404);
  });

  describe("full permission matrix", () => {
    const deniedCreate: UserRole[] = ["accountant", "cashier", "storekeeper", "shareholder", "custom"];
    const deniedRead: UserRole[] = ["cashier", "storekeeper", "shareholder", "custom"];

    it.each(deniedCreate)("denies role=%s creating a tag", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await createTag(token, `Denied ${randomUUID()}`);
      expect(res.status).toBe(403);
    });

    it.each(deniedRead)("denies role=%s listing tags", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).get("/tags").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("allows manager to create and accountant to list but not create", async () => {
      const manager = await createTestUser(businessId, "manager");
      const managerToken = mintAccessToken(manager);
      const createRes = await createTag(managerToken, `Manager Tag ${randomUUID()}`);
      expect(createRes.status).toBe(201);

      const accountant = await createTestUser(businessId, "accountant");
      const accountantToken = mintAccessToken(accountant);
      const listRes = await request(app).get("/tags").set("Authorization", `Bearer ${accountantToken}`);
      expect(listRes.status).toBe(200);
      const accountantCreateRes = await createTag(accountantToken, `x ${randomUUID()}`);
      expect(accountantCreateRes.status).toBe(403);
    });

    it("allows super_admin to create and list regardless of role restrictions", async () => {
      const admin = await createTestUser(businessId, "super_admin");
      const token = mintAccessToken(admin);
      const createRes = await createTag(token, `Admin Tag ${randomUUID()}`);
      expect(createRes.status).toBe(201);
      const listRes = await request(app).get("/tags").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(200);
    });
  });
});
