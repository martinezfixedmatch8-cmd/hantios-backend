import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

// Batch 8 Session B (HNT-OBS-001). Confirmed absent before this session via
// direct grep of src/app.ts and src/routes/ -- these are genuinely new
// endpoints, not a rename/extension of anything existing.
describe("/health and /ready", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("GET /health", () => {
    it("returns 200 without touching the database", async () => {
      const spy = jest.spyOn(prisma, "$queryRaw");
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("includes requestId and no other fields (no stack/connection-string/env leakage)", async () => {
      const res = await request(app).get("/health");
      expect(Object.keys(res.body).sort()).toEqual(["requestId", "status"]);
    });
  });

  describe("GET /ready", () => {
    it("returns 200 when the database is reachable", async () => {
      const res = await request(app).get("/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready");
      expect(res.body.requestId).toBeDefined();
    });

    it("returns a minimal 503 with no error detail when the database check fails (simulated)", async () => {
      const spy = jest.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("simulated connection failure: postgresql://realuser:realpass@real-host/real-db"));
      const res = await request(app).get("/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("not_ready");
      expect(Object.keys(res.body).sort()).toEqual(["requestId", "status"]);
      // The strongest possible proof of no leakage: the simulated error's own
      // message (deliberately crafted to look like a real connection string)
      // must never appear anywhere in the response body.
      expect(JSON.stringify(res.body)).not.toContain("realuser");
      expect(JSON.stringify(res.body)).not.toContain("realpass");
      spy.mockRestore();
    });

    it("returns 503 when the database check hangs past the short timeout (simulated)", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spy = jest.spyOn(prisma, "$queryRaw").mockImplementationOnce(() => new Promise(() => {}) as any); // never resolves
      const res = await request(app).get("/ready");
      expect(res.status).toBe(503);
      spy.mockRestore();
    }, 10_000);
  });
});
