import type {
  ResendLikeClient,
  ResendListDomainsResponse,
  ResendSendPayload,
  ResendSendRequestOptions,
  ResendSendResponse,
} from "../../src/notifications/ResendEmailProvider";

// Test double for ResendLikeClient -- avoids hitting Resend's real network
// in tests, same DI-seam pattern as FakeGoogleAuthProvider (constructor-
// injected into ResendEmailProvider directly, since retry logic needs to be
// unit-tested against something Resend-shaped). Programmed with a queue of
// responses so a test can simulate "fails once, then succeeds" (retry
// exercised, ends in success), "fails twice" (retry exercised, ends in
// failure), or "fails once, non-transiently" (no retry at all).
export class FakeResendClient implements ResendLikeClient {
  calls: ResendSendPayload[] = [];
  // The options object (including idempotencyKey) passed on each call, in
  // the same order as `calls` -- lets a test assert the SAME idempotency
  // key was reused across an internal retry, not regenerated per attempt.
  callOptions: (ResendSendRequestOptions | undefined)[] = [];
  domainListCalls = 0;

  private responseQueue: ResendSendResponse[];
  domainsResponse: ResendListDomainsResponse = {
    data: null,
    error: { message: "not configured", statusCode: null, name: "application_error" },
  };

  constructor(responses: ResendSendResponse[]) {
    this.responseQueue = responses;
  }

  emails = {
    send: async (payload: ResendSendPayload, options?: ResendSendRequestOptions): Promise<ResendSendResponse> => {
      this.calls.push(payload);
      this.callOptions.push(options);
      const next = this.responseQueue[this.calls.length - 1] ?? this.responseQueue[this.responseQueue.length - 1];
      return next;
    },
  };

  domains = {
    list: async (): Promise<ResendListDomainsResponse> => {
      this.domainListCalls++;
      return this.domainsResponse;
    },
  };
}

export function resendSuccess(id = "re_test_id"): ResendSendResponse {
  return { data: { id }, error: null };
}

export function resendError(statusCode: number | null, name = "application_error", message = "simulated failure"): ResendSendResponse {
  return { data: null, error: { message, statusCode, name } };
}
