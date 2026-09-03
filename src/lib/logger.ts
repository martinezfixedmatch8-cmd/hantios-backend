// Batch 8 Session B (HNT-OBS-001) -- vendor-free structured JSON logging.
// Deliberately no third-party logging library (pino/winston/etc.) -- a
// closed, explicit allowlist of primitive fields is simple enough that a
// hand-rolled module (matching this repo's own established convention for
// small, self-contained utilities -- messageTemplates.ts, canonicalJson.ts,
// receiptRenderer.ts) is a better fit than a new dependency.
//
// The allowlist is enforced two ways, not just one: the TypeScript input
// types below are closed (no index signature, no [key: string]: unknown
// escape hatch), AND every writer function below constructs its own output
// object field-by-field -- it never spreads a caller-supplied object
// directly into the logged line. This matters because TypeScript's excess-
// property checking only fires for object literals assigned at the call
// site; a caller passing a pre-built variable (e.g. one accidentally
// widened with extra keys by a future edit) would NOT be caught by the type
// system alone. Field-by-field construction here is what actually prevents
// an unlisted key from ever reaching stdout/stderr, regardless of what a
// caller passes.
//
// Deployed to Railway (per this repo's own documented deployment), which
// ingests stdout/stderr directly as its log stream -- no separate log
// file or shipping agent exists or is introduced here.

export interface RequestLogInput {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  // Only ever populated from req.auth?.businessId (an authenticated
  // request's own tenant id) -- never a client-suppliable value.
  businessId?: string;
}

export function logRequest(input: RequestLogInput): void {
  const line = JSON.stringify({
    level: "info",
    event: "request",
    method: input.method,
    path: input.path,
    status: input.status,
    durationMs: input.durationMs,
    requestId: input.requestId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
  });
  console.log(line);
}

// A small, explicit allowlist of "this shape of code is safe to surface
// as-is" -- Prisma's own error codes (e.g. "P2028", "P2002") are a fixed,
// documented enum-like taxonomy, never raw interpolated data, unlike
// `.message` on the same error. The regex additionally bounds length/
// character shape so even a spoofed/malformed `.code` property on an
// arbitrary thrown value can't smuggle unexpected content through.
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Za-z0-9_]{0,31}$/;

function safeErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && SAFE_ERROR_CODE_PATTERN.test(code)) return code;
  }
  return undefined;
}

// The explicit safe-message policy for unexpected/unhandled errors: NEVER
// log `.message` or `.stack` on an arbitrary caught error. Message content
// on an unexpected error is untrusted by construction -- it can legitimately
// contain raw database values (a Postgres constraint-violation message
// embeds the literal conflicting value), interpolated user input, or a raw
// provider response body. Only two things are logged: the error's own
// constructor name (a fixed, safe taxonomy label -- "TypeError",
// "PrismaClientKnownRequestError", ...) and, when present, a known-safe
// `.code`. This is a real, deliberate reduction from this repo's prior
// behavior (a raw `console.error(err)` including the full stack) -- traded
// for the "no stack/credential/provider/raw-body data leaks through 500
// logs" requirement taking priority over local stack-trace convenience.
export interface UnhandledErrorLogInput {
  requestId: string;
  method: string;
  path: string;
}

export function logUnhandledError(input: UnhandledErrorLogInput, err: unknown): void {
  const line = JSON.stringify({
    level: "error",
    event: "unhandled_error",
    requestId: input.requestId,
    errorName: err instanceof Error ? err.constructor.name : typeof err,
    ...(safeErrorCode(err) ? { errorCode: safeErrorCode(err) } : {}),
    method: input.method,
    path: input.path,
  });
  console.error(line);
}

// HNT-OPS-004 (Batch 9 Session A) -- the rate-limit Store's own error path
// (express-rate-limit's `Logger.error`) has no requestId/method/path to
// attach (the Store interface's `increment`/`decrement`/`resetKey` methods
// receive only a `key` string, never the Express request), so this is a
// second, narrower entry point rather than a forced fit into
// logUnhandledError above -- same allowlist discipline (constructor name +
// safe `.code` only, never `.message`/`.stack`), just without the three
// request-scoped fields that function requires.
export function logRateLimitStoreError(event: "init" | "increment" | "decrement" | "resetKey" | "get", err: unknown): void {
  const line = JSON.stringify({
    level: "error",
    event: "rate_limit_store_error",
    storeOperation: event,
    errorName: err instanceof Error ? err.constructor.name : typeof err,
    ...(safeErrorCode(err) ? { errorCode: safeErrorCode(err) } : {}),
  });
  console.error(line);
}
