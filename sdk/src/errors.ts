/**
 * Every failure from the API (or the network) arrives as one of these, so the app can branch on `status` and `code`
 * without parsing messages. `message` is written for students and safe to show.
 */
export class CommunityApiError extends Error {
  readonly name = "CommunityApiError";

  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got an answer (offline, timeout, aborted). */
    readonly status: number,
    /** Stable code such as `not_found`, `too_many_requests`, `unprocessable_entity`, `network_error`, `aborted`. */
    readonly code: string,
    /** From the Retry-After header on 429/503; null otherwise. */
    readonly retryAfterMs: number | null = null,
    readonly requestId: string | null = null,
    /** Field errors for validation failures: `{ body: ["Required"] }`. */
    readonly details: unknown = undefined,
  ) {
    super(message);
  }

  get isNetworkError() {
    return this.status === 0;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  get isRateLimited() {
    return this.status === 429;
  }
  /** Content was refused by moderation or link checks. */
  get isRefused() {
    return this.status === 422;
  }
}

export const isAbortError = (err: unknown): err is CommunityApiError =>
  err instanceof CommunityApiError && err.code === "aborted";
