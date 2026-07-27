import request from "supertest";
import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner, createTestUser, mintAccessToken } from "./helpers/factories";

describe("Expense Categories", () => {
  const businessIds: string[] = [];
  let businessId: string;
  let ownerToken: string;

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

  it("returns 401 with no token", async () => {
    const res = await request(app).get("/expense-categories");
    expect(res.status).toBe(401);
  });

  it("lazily seeds exactly the 5 fixed SYSTEM categories on first access, idempotently on repeat access", async () => {
    const res = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const systemNames = res.body.data.filter((c: { type: string }) => c.type === "system").map((c: { name: string }) => c.name).sort();
    expect(systemNames).toEqual(["Electricity", "Misc", "Payroll", "Rent", "Transport"]);

    // Second access must not duplicate them.
    const again = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    const systemNamesAgain = again.body.data.filter((c: { type: string }) => c.type === "system");
    expect(systemNamesAgain).toHaveLength(5);
  });

  it("lets the owner create a CUSTOM category", async () => {
    const res = await request(app)
      .post("/expense-categories")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: `Marketing ${randomUUID()}`, color: "#ff0000" });
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("custom");
    expect(res.body.data.active).toBe(true);
  });

  it("returns 400 for a duplicate category name within the same business", async () => {
    const name = `Duplicate ${randomUUID()}`;
    const first = await request(app).post("/expense-categories").set("Authorization", `Bearer ${ownerToken}`).send({ name });
    expect(first.status).toBe(201);

    const second = await request(app).post("/expense-categories").set("Authorization", `Bearer ${ownerToken}`).send({ name });
    expect(second.status).toBe(400);
  });

  it("lets the owner rename/recolor a CUSTOM category", async () => {
    const created = await request(app)
      .post("/expense-categories")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: `Renamable ${randomUUID()}` });
    const newName = `Renamed ${randomUUID()}`;
    const res = await request(app)
      .patch(`/expense-categories/${created.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: newName, color: "#00ff00" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe(newName);
    expect(res.body.data.color).toBe("#00ff00");
  });

  it("rejects modifying a SYSTEM category", async () => {
    const list = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    const systemCategory = list.body.data.find((c: { type: string }) => c.type === "system");
    const res = await request(app)
      .patch(`/expense-categories/${systemCategory.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Hacked Rent" });
    expect(res.status).toBe(400);
  });

  it("lets the owner deactivate a CUSTOM category, and rejects deactivating it twice", async () => {
    const created = await request(app)
      .post("/expense-categories")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: `Deactivatable ${randomUUID()}` });

    const res = await request(app).post(`/expense-categories/${created.body.data.id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);

    const again = await request(app).post(`/expense-categories/${created.body.data.id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);
    expect(again.status).toBe(400);
  });

  it("rejects deactivating a SYSTEM category", async () => {
    const list = await request(app).get("/expense-categories?pageSize=50").set("Authorization", `Bearer ${ownerToken}`);
    const systemCategory = list.body.data.find((c: { type: string; active: boolean }) => c.type === "system" && c.active);
    const res = await request(app).post(`/expense-categories/${systemCategory.id}/deactivate`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a category belonging to a different business", async () => {
    const otherOwner = await signupTestOwner();
    businessIds.push(otherOwner.businessId);
    const otherLogin = await loginTestOwner(otherOwner.email, otherOwner.password, otherOwner.deviceId);
    const otherCreated = await request(app)
      .post("/expense-categories")
      .set("Authorization", `Bearer ${otherLogin.accessToken}`)
      .send({ name: `Other Business Category ${randomUUID()}` });

    const res = await request(app)
      .patch(`/expense-categories/${otherCreated.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Stolen" });
    expect(res.status).toBe(404);
  });

  it("returns a {data, pagination} envelope", async () => {
    const res = await request(app).get("/expense-categories?pageSize=1").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("pagination");
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });

  describe("full permission matrix", () => {
    const deniedCreate: UserRole[] = ["manager", "accountant", "cashier", "storekeeper", "shareholder", "custom"];
    const deniedRead: UserRole[] = ["cashier", "storekeeper", "shareholder", "custom"];

    it.each(deniedCreate)("denies role=%s creating a category", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).post("/expense-categories").set("Authorization", `Bearer ${token}`).send({ name: `Denied ${randomUUID()}` });
      expect(res.status).toBe(403);
    });

    it.each(deniedRead)("denies role=%s listing categories", async (role) => {
      const user = await createTestUser(businessId, role);
      const token = mintAccessToken(user);
      const res = await request(app).get("/expense-categories").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("allows manager and accountant to list, but not create", async () => {
      for (const role of ["manager", "accountant"] as UserRole[]) {
        const user = await createTestUser(businessId, role);
        const token = mintAccessToken(user);
        const listRes = await request(app).get("/expense-categories").set("Authorization", `Bearer ${token}`);
        expect(listRes.status).toBe(200);
        const createRes = await request(app).post("/expense-categories").set("Authorization", `Bearer ${token}`).send({ name: `x ${randomUUID()}` });
        expect(createRes.status).toBe(403);
      }
    });

    it("allows super_admin to create and list regardless of role restrictions", async () => {
      const admin = await createTestUser(businessId, "super_admin");
      const token = mintAccessToken(admin);
      const createRes = await request(app).post("/expense-categories").set("Authorization", `Bearer ${token}`).send({ name: `Admin Category ${randomUUID()}` });
      expect(createRes.status).toBe(201);
      const listRes = await request(app).get("/expense-categories").set("Authorization", `Bearer ${token}`);
      expect(listRes.status).toBe(200);
    });
  });
});
