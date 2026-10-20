import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildFetchWithCa } from "./fetch-with-ca.js";
import { PACKAGE_VERSION } from "../version.js";

export interface McpClientOptions {
  /** Optional path to a PEM bundle to add to the trusted CA list */
  extraCaCertPath?: string;
  /** Optional API key sent as `X-API-Key` when required by the upstream MCP server */
  apiKey?: string;
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

  constructor(serverUrl: string, options: McpClientOptions = {}) {
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

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        await this.client.connect(this.transport);
        const instr = this.client.getInstructions();
        this.serverInstructions = typeof instr === "string" ? instr : "";
        this.connected = true;
      })().catch((err) => {
        // Clear the cached promise so callers can retry instead of being
        // stuck with a permanently-rejected promise for the lifetime of
        // the proxy.
        this.connectPromise = null;
        throw err;
      });
    }
    await this.connectPromise;
  }

  getServerInstructions(): string {
    return this.serverInstructions;
  }

  async listTools(): Promise<Tool[]> {
    await this.connect();
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    await this.connect();
    return (await this.client.callTool({
      name,
      arguments: args ?? {},
    })) as CallToolResult;
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
