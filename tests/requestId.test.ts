import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner, loginTestOwner } from "./helpers/factories";
import { requestId as requestIdMiddleware } from "../src/middleware/requestId";

// Batch 8 Session B (HNT-OBS-001) -- request-ID generation/validation and
// its propagation into both the response header and every error response
// body (Zod/400, AppError/4xx, and the generic 404 fallback).
describe("Request ID correlation", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idemKey = () => `test-${randomUUID()}`;
  const businessIds: string[] = [];

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
  });

  it("generates a UUID and sets it on the response header when no X-Request-Id is sent", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(res.headers["x-request-id"]).toMatch(UUID_RE);
  });

  it("echoes back a valid inbound X-Request-Id unchanged", async () => {
    const res = await request(app).get("/health").set("X-Request-Id", "my-valid-id_123");
    expect(res.headers["x-request-id"]).toBe("my-valid-id_123");
  });

  it("accepts the full allowed character set and max length (64 chars)", async () => {
    const id = "A".repeat(64);
    const res = await request(app).get("/health").set("X-Request-Id", id);
    expect(res.headers["x-request-id"]).toBe(id);
  });

  it.each([
    ["too long (65 chars)", "A".repeat(65)],
    ["contains a space", "bad id with spaces"],
    ["contains a semicolon", "bad;id"],
    ["empty string", ""],
    ["contains a slash", "bad/id"],
  ])("falls back to a fresh UUID when the inbound header is invalid: %s", async (_label, badId) => {
    const res = await request(app).get("/health").set("X-Request-Id", badId);
    expect(res.headers["x-request-id"]).not.toBe(badId);
    expect(res.headers["x-request-id"]).toMatch(UUID_RE);
  });

  // A literal newline/control character can't be exercised through a real
  // HTTP client at all -- Node's own http client (superagent, underneath
  // supertest) throws synchronously on `.set()` for any header value
  // containing one, and Node's HTTP *server* parser rejects a raw request
  // line/header containing one before Express ever sees it. Both stacks
  // already provide defense in depth here. Tested directly against the
  // middleware function instead, bypassing HTTP transport entirely, so the
  // application-level regex's own behavior for this case is still proven.
  it("the request-id validation regex itself rejects embedded control characters (defense in depth beyond what HTTP transport already blocks)", () => {
    const headers: Record<string, string> = { "X-Request-Id": "bad\nid" };
    const fakeReq = { header: (name: string) => headers[name] } as unknown as Parameters<typeof requestIdMiddleware>[0];
    const setHeaderCalls: Record<string, string> = {};
    const fakeRes = { setHeader: (name: string, value: string) => (setHeaderCalls[name] = value) } as unknown as Parameters<typeof requestIdMiddleware>[1];
    requestIdMiddleware(fakeReq, fakeRes, () => {});
    expect(setHeaderCalls["X-Request-Id"]).not.toBe("bad\nid");
    expect(setHeaderCalls["X-Request-Id"]).toMatch(UUID_RE);
  });

  it("includes the same request id in a genuine ZodError (400) response body as the response header", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);
    const login = await loginTestOwner(owner.email, owner.password, owner.deviceId);

    const res = await request(app)
      .post("/branches")
      .set("Authorization", `Bearer ${login.accessToken}`)
      .set("Idempotency-Key", idemKey())
      .send({}); // missing required "name" -- a genuine createBranchSchema ZodError
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
    expect(res.body.error.requestId).toBeDefined();
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("includes requestId in the AppError (4xx) response body, matching the response header", async () => {
    const res = await request(app).get("/branches/00000000-0000-0000-0000-000000000000");
    // No Authorization header at all -- authenticate.ts's own unauthorized() AppError path.
    expect(res.status).toBe(401);
    expect(res.body.error.requestId).toBeDefined();
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("includes requestId in the generic 404 (no matching route) response body", async () => {
    const res = await request(app).get("/this-route-does-not-exist-anywhere");
    expect(res.status).toBe(404);
    expect(res.body.error.requestId).toBeDefined();
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("a caller-supplied request id is preserved through to the error response body too", async () => {
    const res = await request(app).get("/this-route-does-not-exist-anywhere").set("X-Request-Id", "trace-me-please");
    expect(res.headers["x-request-id"]).toBe("trace-me-please");
    expect(res.body.error.requestId).toBe("trace-me-please");
  });
});
