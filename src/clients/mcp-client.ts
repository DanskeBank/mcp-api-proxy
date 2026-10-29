import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ProxyError } from "../errors.js";
import { buildFetchWithCa } from "./fetch-with-ca.js";
import { isKeyRefusal, recentKeyRefusal, rememberKeyRefusal } from "./key-refusal.js";
import { PACKAGE_VERSION } from "../version.js";

export interface McpClientOptions {
  /** Optional path to a PEM bundle to add to the trusted CA list */
  extraCaCertPath?: string;
  /** Optional API key sent as `X-API-Key` when required by the upstream MCP server */
  apiKey?: string;
}

// The hosted server answers a missing or rejected API key with this JSON-RPC
// code. The SDK uses the same number for its own request timeouts, so the
// message is checked as well.
const API_KEY_ERROR_CODE = -32001;

const KEY_NOT_SET_HINT =
  "MCP_SERVER_API_KEY is not set. The hosted MCP server requires an API key: " +
  "get one at https://developers.danskebank.com/mcp/apikey, add MCP_SERVER_API_KEY " +
  "to the proxy settings and restart the proxy.";
const KEY_REJECTED_HINT =
  "The hosted MCP server rejected MCP_SERVER_API_KEY. " +
  "Check that the key is correct and complete, then restart the proxy.";

function apiKeyHint(hasApiKey: boolean): string {
  return hasApiKey ? KEY_REJECTED_HINT : KEY_NOT_SET_HINT;
}

function classifyApiKeyError(err: McpError, hasApiKey: boolean): ProxyError {
  // Matches the server's fixed rejection messages; other wording is reported as a rejected key.
  if (/too many/i.test(err.message)) {
    return new ProxyError("rate_limited", {
      cause: err,
      hint:
        "The hosted MCP server received too many invalid API key attempts from this address. " +
        "Wait a few minutes, check MCP_SERVER_API_KEY, then restart the proxy.",
    });
  }
  if (/could not be verified/i.test(err.message)) {
    return new ProxyError("upstream", {
      cause: err,
      hint:
        "The hosted MCP server could not verify the API key right now. " +
        "This is usually temporary: try again later, then restart the proxy.",
    });
  }
  return new ProxyError("auth", { cause: err, hint: apiKeyHint(hasApiKey) });
}

/**
 * Turns an upstream API-key rejection into a proxy-owned error that tells the
 * user what to fix. Upstream text is never copied; other errors return undefined.
 */
export function classifyUpstreamError(
  err: unknown,
  hasApiKey: boolean,
): ProxyError | undefined {
  if (
    err instanceof McpError &&
    err.code === API_KEY_ERROR_CODE &&
    /api[- ]key/i.test(err.message)
  ) {
    return classifyApiKeyError(err, hasApiKey);
  }
  if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) {
    return new ProxyError("auth", {
      cause: err,
      statusCode: err.code,
      hint: apiKeyHint(hasApiKey),
    });
  }
  return undefined;
}

/**
 * Wraps a fetch function to attach a static `X-API-Key` header to every
 * outgoing request. No-op when no key is configured.
 */
function withApiKey(baseFetch: typeof fetch, apiKey: string): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-API-Key", apiKey);
    return baseFetch(input, { ...init, headers });
  };
}

/**
 * Wraps a fetch function to maintain a simple cookie jar.
 * Required because the upstream MCP server sits behind a load balancer
 * (AWS ALB / Netscaler) that uses sticky-session cookies.
 * Node.js fetch does not handle cookies automatically.
 */
function withCookieJar(baseFetch: typeof fetch): typeof fetch {
  const cookies = new Map<string, string>();

  return async (input, init) => {
    // Attach accumulated cookies to the outgoing request
    if (cookies.size > 0) {
      const cookieHeader = [...cookies.values()].join("; ");
      const headers = new Headers(
        (init as RequestInit | undefined)?.headers ?? {},
      );
      // Merge with any existing Cookie header
      const existing = headers.get("Cookie");
      headers.set(
        "Cookie",
        existing ? `${existing}; ${cookieHeader}` : cookieHeader,
      );
      init = { ...init, headers } as RequestInit;
    }

    const response = await baseFetch(input, init);

    // Collect Set-Cookie headers from the response
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      const nameValue = raw.split(";")[0]; // "NAME=VALUE"
      const eqIdx = nameValue.indexOf("=");
      if (eqIdx > 0) {
        const name = nameValue.slice(0, eqIdx);
        cookies.set(name, nameValue);
      }
    }

    return response;
  };
}

/**
 * Wraps the MCP SDK Client to talk to the hosted Danske Bank MCP server.
 * Used by discovery tools to forward calls upstream.
 */
export class McpClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private serverInstructions = "";
  private readonly serverUrl: string;
  private readonly apiKey: string | undefined;

  constructor(serverUrl: string, options: McpClientOptions = {}) {
    this.serverUrl = serverUrl;
    this.apiKey = options.apiKey;
    const baseFetch = options.extraCaCertPath
      ? buildFetchWithCa(options.extraCaCertPath)
      : fetch;

    const keyedFetch = options.apiKey
      ? withApiKey(baseFetch, options.apiKey)
      : baseFetch;

    const cookieFetch = withCookieJar(keyedFetch);

    this.transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      fetch: cookieFetch,
    });
    this.client = new Client(
      { name: "danske-mcp-api-proxy", version: PACKAGE_VERSION },
      { capabilities: {} },
    );
  }

  /**
   * Runs an upstream call, explaining an API-key rejection instead of the raw SDK
   * error and not sending a key again that the server refused moments ago.
   */
  private async explainingKeyErrors<T>(call: () => Promise<T>): Promise<T> {
    const remembered = recentKeyRefusal(this.serverUrl, this.apiKey);
    if (remembered) throw remembered;
    try {
      return await call();
    } catch (err) {
      const explained = classifyUpstreamError(err, Boolean(this.apiKey));
      if (isKeyRefusal(explained)) rememberKeyRefusal(this.serverUrl, this.apiKey, explained);
      throw explained ?? err;
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connectPromise ??= this.explainingKeyErrors(async () => {
      await this.client.connect(this.transport);
      const instr = this.client.getInstructions();
      this.serverInstructions = typeof instr === "string" ? instr : "";
      this.connected = true;
    }).catch((err) => {
      // Clear the cached promise so callers can retry instead of being
      // stuck with a permanently-rejected promise for the lifetime of
      // the proxy.
      this.connectPromise = null;
      throw err;
    });
    await this.connectPromise;
  }

  getServerInstructions(): string {
    return this.serverInstructions;
  }

  async listTools(): Promise<Tool[]> {
    await this.connect();
    const result = await this.explainingKeyErrors(() => this.client.listTools());
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    await this.connect();
    return (await this.explainingKeyErrors(() =>
      this.client.callTool({ name, arguments: args ?? {} }),
    )) as CallToolResult;
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
    try {
      await this.transport.close();
    } catch {
      // Transport may already be closed by the SDK — ignore.
    }
  }
}
