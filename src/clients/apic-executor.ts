import { fetch as undiciFetch } from "undici";
import type { ApiResponse, ExecuteParams } from "../types/index.js";
import { buildFetchWithCa } from "./fetch-with-ca.js";
import type { TokenManager, AuthTier } from "../auth/token-manager.js";

export interface AuthFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export interface ApicExecutorOptions {
  /** Optional path to an extra CA bundle (PEM) for the mock tier. */
  extraCaCertPath?: string;
  /** Required for sandbox/live calls. May be omitted for mock-only deployments. */
  tokenManager?: TokenManager;
  /**
   * Test seam: low-level fetcher used for sandbox/live calls.
   * Defaults to `undici.fetch` with the tier's mTLS dispatcher applied.
   */
  authFetch?: (
    tier: AuthTier,
    url: string,
    init: AuthFetchInit,
  ) => Promise<Response>;
}

/** Hard cap on response body size to protect against runaway upstream responses. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * HTTP executor for API Connect calls.
 *
 * - mock tier: unauthenticated, uses the extra CA bundle when configured.
 * - sandbox / live: mTLS Dispatcher from TokenManager + Bearer token.
 *   On a 401 the token is invalidated and the call is retried once.
 */
export class ApicExecutor {
  private readonly mockFetch: typeof fetch;
  private readonly tokenManager?: TokenManager;
  private readonly authFetchImpl: ApicExecutorOptions["authFetch"];

  constructor(options: ApicExecutorOptions = {}) {
    this.mockFetch = options.extraCaCertPath
      ? buildFetchWithCa(options.extraCaCertPath)
      : fetch;
    this.tokenManager = options.tokenManager;
    this.authFetchImpl = options.authFetch;
  }

  async execute(params: ExecuteParams): Promise<ApiResponse> {
    const url = new URL(params.url);
    if (params.queryParams) {
      for (const [key, value] of Object.entries(params.queryParams)) {
        url.searchParams.set(key, value);
      }
    }

    const baseHeaders: Record<string, string> = stripReservedHeaders(
      params.headers ?? {},
    );

    const bodyText =
      params.body && params.method !== "GET" && params.method !== "DELETE"
        ? JSON.stringify(params.body)
        : undefined;
    if (bodyText) baseHeaders["content-type"] = "application/json";

    if (params.tier === "mock") {
      return this.callMock(
        params.method,
        url.toString(),
        baseHeaders,
        bodyText,
      );
    }

    return this.callAuthenticated(
      params.tier,
      params.method,
      url.toString(),
      baseHeaders,
      bodyText,
    );
  }

  private async callMock(
    method: string,
    url: string,
    headers: Record<string, string>,
    bodyText: string | undefined,
  ): Promise<ApiResponse> {
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(30_000),
    };
    if (bodyText) init.body = bodyText;
    const response = await this.mockFetch(url, init);
    return this.materializeResponse(response);
  }

  private async callAuthenticated(
    tier: AuthTier,
    method: string,
    url: string,
    headers: Record<string, string>,
    bodyText: string | undefined,
  ): Promise<ApiResponse> {
    if (!this.tokenManager) {
      throw new Error(
        `ApicExecutor was constructed without a TokenManager — cannot call ${tier} tier.`,
      );
    }
    const tokenManager = this.tokenManager;

    const doCall = async (): Promise<Response> => {
      const token = await tokenManager.getToken(tier);
      const callHeaders: Record<string, string> = {
        ...headers,
        authorization: `Bearer ${token}`,
      };
      const init: AuthFetchInit = {
        method,
        headers: callHeaders,
        signal: AbortSignal.timeout(30_000),
        ...(bodyText ? { body: bodyText } : {}),
      };
      if (this.authFetchImpl) {
        return this.authFetchImpl(tier, url, init);
      }
      return undiciFetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: init.signal,
        dispatcher: tokenManager.getDispatcher(tier),
        // Return a 3xx as is: following it would carry the bearer token and client certificate along.
        redirect: "manual",
      });
    };

    let response = await doCall();
    if (response.status === 401) {
      // Drain the response body to free the connection back to the pool
      await response.body?.cancel().catch(() => {});
      tokenManager.invalidate(tier);
      response = await doCall();
    }
    return this.materializeResponse(response);
  }

  private async materializeResponse(response: Response): Promise<ApiResponse> {
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const cl = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(cl) && cl > MAX_RESPONSE_BYTES) {
        await cancelOversizedBody(response.body);
        throw new Error(
          `Response body too large: ${contentLength} bytes exceeds ${MAX_RESPONSE_BYTES}-byte limit.`,
        );
      }
    }

    const text = await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
    let body: unknown;
    if (/^application\/(?:json|[\w!#$%&'*+.^`|~-]+\+json)$/i.test(contentType)) {
      try {
        body = text.length === 0 ? null : JSON.parse(text);
      } catch {
        // Upstream lied about content-type. Surface raw text rather than a
        // cryptic parse error so the LLM can still see what came back.
        body = text;
      }
    } else {
      body = text;
    }

    return { status: response.status, headers: responseHeaders, body };
  }
}

async function cancelOversizedBody(body: { cancel(): Promise<void> } | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Keep the size-limit error even when cancellation fails.
    console.error("[proxy] Could not cancel an oversized API response body.");
  }
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await cancelOversizedBody(reader);
        throw new Error(
          `Response body exceeded ${maxBytes}-byte limit (read ${total} bytes).`,
        );
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

const RESERVED = new Set([
  "authorization",
  "content-type",
  "host",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "transfer-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

function stripReservedHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!RESERVED.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}
