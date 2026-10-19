/// <reference lib="dom" />
import { CommunityApiError } from "./errors.js";

export interface HttpOptions {
  /** Origin of the Community API, e.g. https://community-api.pyqdeck.in. Separate from the main API's origin. */
  baseUrl: string;
  /** The same Clerk token source the app's main API client uses. Return null when signed out. */
  getToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Per-request timeout. Default 15 s. Implemented with AbortController: Hermes has no AbortSignal.timeout. */
  timeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

interface Call extends RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
}

export interface Envelope<T> {
  data: T;
  /** Cursor lists send `nextCursor` and `hasMore`; the few offset lists (moderation history) send page numbers. */
  pagination?: {
    nextCursor?: string | null;
    hasMore?: boolean;
    total?: number;
    page?: number;
    limit?: number;
    totalPages?: number;
    hasNext?: boolean;
    hasPrev?: boolean;
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class Http {
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: HttpOptions) {
    this.doFetch = options.fetch ?? ((...args) => fetch(...args));
  }

  get baseUrl() {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  getToken() {
    return this.options.getToken();
  }

  async call<T>(call: Call): Promise<Envelope<T>> {
    const url = new URL(this.baseUrl + call.path);
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    // Sends no Authorization header when signed out, so the server answers with its own 401.
    const token = await this.options.getToken().catch(() => null);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(call.body !== undefined && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...call.headers,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onOuterAbort = () => controller.abort();
    if (call.signal) {
      if (call.signal.aborted) controller.abort();
      else call.signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    if (call.signal?.aborted) {
      clearTimeout(timer);
      throw new CommunityApiError("Request cancelled", 0, "aborted");
    }

    let response: Response;
    try {
      response = await this.doFetch(url.toString(), {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal: controller.signal,
      });
    } catch {
      const timedOut = !call.signal?.aborted && controller.signal.aborted;
      if (call.signal?.aborted) throw new CommunityApiError("Request cancelled", 0, "aborted");
      throw new CommunityApiError(
        timedOut
          ? "The request took too long. Check your connection and try again."
          : "Could not reach the server. Check your connection.",
        0,
        timedOut ? "timeout" : "network_error",
      );
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", onOuterAbort);
    }

    return this.parse<T>(response);
  }

  private async parse<T>(response: Response): Promise<Envelope<T>> {
    if (response.status === 204) return { data: undefined as T };

    let json: {
      success?: boolean;
      data?: T;
      message?: string;
      code?: string;
      details?: unknown;
      requestId?: string;
      pagination?: Envelope<T>["pagination"];
    } | null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok || !json || json.success === false) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new CommunityApiError(
        json?.message ?? `Something went wrong (${response.status})`,
        response.status,
        json?.code ?? `http_${response.status}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
        json?.requestId ?? response.headers.get("x-request-id"),
        json?.details,
      );
    }
    return { data: json.data as T, pagination: json.pagination };
  }
}
