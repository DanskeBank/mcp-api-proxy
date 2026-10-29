import { afterEach, describe, expect, it, vi } from "vitest";
import { format } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "../src/tools/discovery.js";
import type { McpClient } from "../src/clients/mcp-client.js";
import type { ApicExecutor } from "../src/clients/apic-executor.js";
import type { Config } from "../src/config/config.js";
import { ProxyError } from "../src/errors.js";
import {
  ConsoleAuditLogger,
  type AuditEvent,
  type AuditLogger,
} from "../src/middleware/audit-logger.js";
import type { ApiResponse } from "../src/types/index.js";

function makeConfig(): Config {
  return {
    env: "test",
    mcpServerUrl: "https://test-mcp.danskebank.com/mcp",
    apiHosts: {
      mock: "test-mock-api.danskebank.com",
      live: "test-api.danskebank.com",
    },
    tokenScope: "accounts",
  };
}

function makeUpstream(
  overrides: Partial<{
    listTools: () => Promise<unknown[]>;
    callTool: (
      name: string,
      args: Record<string, unknown> | undefined,
    ) => Promise<unknown>;
  }> = {},
): McpClient {
  return {
    listTools: overrides.listTools ?? vi.fn().mockResolvedValue([]),
    callTool:
      overrides.callTool ??
      vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      }),
  } as unknown as McpClient;
}

function makeExecutor(response: ApiResponse): ApicExecutor {
  return {
    execute: vi.fn().mockResolvedValue(response),
  } as unknown as ApicExecutor;
}

async function setupClient(opts: {
  upstream?: McpClient | null;
  executor?: ApicExecutor;
  auditLogger?: AuditLogger;
  upstreamProblem?: ProxyError;
}) {
  const server = new McpServer(
    { name: "test-proxy", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(
    server,
    opts.upstream === undefined ? makeUpstream() : opts.upstream,
    {
      config: makeConfig(),
      apicExecutor:
        opts.executor ??
        makeExecutor({ status: 200, headers: {}, body: { ok: true } }),
    },
    { auditLogger: opts.auditLogger, upstreamProblem: opts.upstreamProblem },
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return { client, server };
}

describe("registerTools", () => {
  afterEach(() => vi.restoreAllMocks());

  it("appends call_endpoint to the upstream tool list", async () => {
    const upstream = makeUpstream({
      listTools: vi
        .fn()
        .mockResolvedValue([
          { name: "search_apis", inputSchema: { type: "object" } },
        ]),
    });
    const { client } = await setupClient({ upstream });
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("search_apis");
    expect(names).toContain("call_endpoint");
  });

  it.each([
    { readOnlyHint: true, openWorldHint: false },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  ])("forwards all hosted tool metadata unchanged (%#)", async (hints) => {
    const hostedTools = [
      "get_filters", "search_apis", "get_api_info", "get_endpoint_details",
      "get_business_description", "get_auth_guide",
    ].map((name) => ({
      name,
      title: `Hosted ${name}`,
      description: "Hosted description.",
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      annotations: {
        title: `Hosted ${name}`,
        ...hints,
      },
    }));
    const { client, server } = await setupClient({
      upstream: makeUpstream({ listTools: vi.fn().mockResolvedValue(hostedTools) }),
    });
    try {
      const list = await client.listTools();
      expect(list.tools).toHaveLength(7);
      expect(list.tools.slice(0, 6)).toEqual(hostedTools);
      expect(list.tools[6]).toMatchObject({
        name: "call_endpoint",
        title: "Call API endpoint",
        outputSchema: { type: "object" },
      });
      expect(list.tools[6].annotations).toEqual({
        title: "Call API endpoint",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    { label: "JSON response", status: 200, body: { accounts: [] } },
    { label: "empty response", status: 204, body: null },
    { label: "text response", status: 200, body: "plain text" },
    { label: "array response", status: 200, body: [1, 2] },
    { label: "redirect", status: 302, body: "" },
    { label: "API error", status: 404, body: { detail: "not found" } },
    { label: "upstream error", status: 503, body: "unavailable" },
    { label: "invalid arguments", args: {} },
    { label: "missing credentials", args: { method: "GET", url: "/accounts", tier: "live" } },
    { label: "transport failure", failure: new Error("private-transport-marker") },
  ])("validates the $label result over MCP after tools/list", async ({ status, body, args, failure }) => {
    const executor = makeExecutor({ status: status ?? 200, headers: {}, body });
    if (failure) vi.mocked(executor.execute).mockRejectedValueOnce(failure);
    const { client, server } = await setupClient({ executor, upstream: null });
    try {
      await client.listTools();
      const result = CallToolResultSchema.parse(await client.callTool({
        name: "call_endpoint",
        arguments: args ?? { method: "GET", url: "/accounts", tier: "mock" },
      }));
      const first = result.content[0];
      if (first?.type !== "text") throw new Error("Expected a text result");
      const payload: unknown = JSON.parse(first.text);
      expect(result.structuredContent).toEqual(payload);
      expect(JSON.stringify(result)).not.toContain("private-transport-marker");
      if (status !== undefined) {
        expect(result.structuredContent).toMatchObject({ tier: "mock", status, headers: {}, body });
        expect(result._meta?.statusCode).toBe(status);
        expect(result.isError).toBe(status >= 400 ? true : undefined);
      } else {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toHaveProperty("error.nextStep");
        expect(result.structuredContent).not.toHaveProperty("status");
        expect(executor.execute).toHaveBeenCalledTimes(failure ? 1 : 0);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps the local tool available without an upstream connection", async () => {
    const { client, server } = await setupClient({ upstream: null });
    try {
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual(["call_endpoint"]);
      expect(list.tools[0].annotations).toEqual({
        title: "Call API endpoint",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });

      const result = await client.callTool({ name: "call_endpoint", arguments: {
        method: "GET", url: "/accounts", tier: "mock",
      } });
      expect(result.isError).toBeFalsy();

      const unavailable = await client.callTool({ name: "search_apis", arguments: {} });
      expect(unavailable.isError).toBe(true);
      expect(JSON.stringify(unavailable.content)).toContain("not connected");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("tells the agent why hosted discovery is unavailable when the API key was refused", async () => {
    const problem = new ProxyError("auth", {
      hint: "The hosted MCP server rejected MCP_SERVER_API_KEY. Check the key.",
    });
    const events: AuditEvent[] = [];
    const { client, server } = await setupClient({
      upstream: null,
      upstreamProblem: problem,
      auditLogger: {
        logToolCall: async () => {},
        logToolResult: async (event) => {
          events.push(event);
        },
      },
    });
    try {
      const unavailable = await client.callTool({ name: "search_apis", arguments: {} });
      expect(unavailable.isError).toBe(true);
      expect(unavailable._meta).toEqual({ errorCategory: "auth" });
      const text = JSON.stringify(unavailable.content);
      expect(text).toContain("[auth]");
      expect(text).toContain("rejected MCP_SERVER_API_KEY");
      expect(text).toContain('only \\"call_endpoint\\" is available');
      expect(text).toContain("discovery returns once it is resolved and the proxy is restarted");
      expect(text).toContain("Do not retry the discovery tools.");
      expect(text).not.toContain("not connected");
      expect(events[0].result?.error).toBe("[auth]");

      const local = await client.callTool({ name: "call_endpoint", arguments: {
        method: "GET", url: "/accounts", tier: "mock",
      } });
      expect(local.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps an API-key explanation from upstream tools/list and tools/call failures", async () => {
    const problem = new ProxyError("auth", {
      hint: "The hosted MCP server rejected MCP_SERVER_API_KEY. Check the key.",
    });
    const upstream = makeUpstream({
      listTools: vi.fn().mockRejectedValue(problem),
      callTool: vi.fn().mockRejectedValue(problem),
    });
    const { client, server } = await setupClient({ upstream });
    try {
      await expect(client.listTools()).rejects.toThrow(/\[auth\].*rejected MCP_SERVER_API_KEY/);
      await expect(client.callTool({ name: "search_apis", arguments: {} })).rejects.toThrow(
        /\[auth\].*rejected MCP_SERVER_API_KEY/,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("forwards non-call_endpoint tools to the upstream MCP client", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    });
    const upstream = makeUpstream({ callTool });
    const { client } = await setupClient({ upstream });

    await client.callTool({ name: "search_apis", arguments: { q: "x" } });
    expect(callTool).toHaveBeenCalledWith("search_apis", { q: "x" });
  });

  it("logs the real upstream HTTP status code, not a fabricated one", async () => {
    const events: AuditEvent[] = [];
    const auditLogger: AuditLogger = {
      logToolCall: vi.fn(async (e) => {
        events.push(e);
      }),
      logToolResult: vi.fn(async (e) => {
        events.push(e);
      }),
    };
    const executor = makeExecutor({
      status: 418,
      headers: {},
      body: { teapot: true },
    });
    const { client } = await setupClient({ executor, auditLogger });

    await client.callTool({
      name: "call_endpoint",
      arguments: {
        method: "GET",
        url: "https://test-mock-api.danskebank.com/foo",
      },
    });

    const result = events.find((e) => e.result);
    expect(result?.result?.statusCode).toBe(418);
  });

  it.each([
    { status: 400, category: "validation" },
    { status: 401, category: "auth" },
    { status: 404, category: "not_found" },
    { status: 429, category: "rate_limited" },
    { status: 500, category: "upstream" },
  ])("retains HTTP $status API data for the client, not either audit sink", async ({ status, category }) => {
    const sentinel = "private-api-response-and-header-123";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: AuditEvent[] = [];
    const consoleLogger = new ConsoleAuditLogger();
    const auditLogger: AuditLogger = {
      async logToolCall(event) {
        events.push(event);
        await consoleLogger.logToolCall(event);
      },
      async logToolResult(event) {
        events.push(event);
        await consoleLogger.logToolResult(event);
      },
    };
    const response: ApiResponse = {
      status, headers: { "x-private-response": sentinel }, body: { detail: sentinel },
    };
    const { client, server } = await setupClient({
      executor: makeExecutor(response), auditLogger,
    });
    try {
      const result = await client.callTool({
        name: "call_endpoint",
        arguments: { method: "GET", url: "/accounts", tier: "mock" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(sentinel);
      expect(result._meta?.statusCode).toBe(status);
      expect(events[0].apiCall?.targetTier).toBe("mock");
      expect(events[1].apiCall?.targetTier).toBe("mock");
      expect(events[1].result).toMatchObject({ statusCode: status, error: `[${category}]` });
      expect(JSON.stringify(events)).not.toContain(sentinel);
      expect(log.mock.calls.map((args) => format(...args)).join("\n")).not.toContain(sentinel);
      const line = JSON.parse(String(log.mock.calls[1][0]));
      expect(line).toMatchObject({ targetTier: "mock", statusCode: status, error: category });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not include statusCode for forwarded tools", async () => {
    const events: AuditEvent[] = [];
    const auditLogger: AuditLogger = {
      logToolCall: vi.fn(async (e) => {
        events.push(e);
      }),
      logToolResult: vi.fn(async (e) => {
        events.push(e);
      }),
    };
    const { client } = await setupClient({ auditLogger });

    await client.callTool({ name: "search_apis", arguments: {} });
    const result = events.find((e) => e.result);
    expect(result?.result?.statusCode).toBeUndefined();
  });

  it("does not crash the tool call when the audit logger throws", async () => {
    const auditLogger: AuditLogger = {
      logToolCall: vi.fn().mockRejectedValue(new Error("splunk down")),
      logToolResult: vi.fn().mockRejectedValue(new Error("splunk still down")),
    };
    const { client } = await setupClient({ auditLogger });

    const res = await client.callTool({
      name: "call_endpoint",
      arguments: {
        method: "GET",
        url: "https://test-mock-api.danskebank.com/foo",
      },
    });
    expect(res.isError).toBeFalsy();
    expect(auditLogger.logToolCall).toHaveBeenCalled();
    expect(auditLogger.logToolResult).toHaveBeenCalled();
  });

  it("populates apiCall details only when args parse successfully", async () => {
    const events: AuditEvent[] = [];
    const auditLogger: AuditLogger = {
      logToolCall: vi.fn(async (e) => {
        events.push(e);
      }),
      logToolResult: vi.fn(async (e) => {
        events.push(e);
      }),
    };
    const { client } = await setupClient({ auditLogger });

    // Invalid args — handleCallEndpoint will return isError, but apiCall on
    // the audit event must NOT be built from the unvalidated input.
    await client.callTool({
      name: "call_endpoint",
      arguments: { method: "WRONG", url: 42 },
    });
    expect(events[0]?.apiCall).toBeUndefined();
  });

  it("masks all path segments and query values in default audit lines", async () => {
    const sentinel = "private-sentinel-8675309";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const executor = {
      execute: vi.fn().mockRejectedValue(new Error(sentinel)),
    } as unknown as ApicExecutor;
    const { client } = await setupClient({
      executor,
      auditLogger: new ConsoleAuditLogger(),
    });

    const result = await client.callTool({
      name: "call_endpoint",
      arguments: {
        method: "GET",
        url: `https://test-mock-api.danskebank.com/accounts/${sentinel}/transactions?token=${sentinel}#${sentinel}`,
      },
    });

    expect(
      log.mock.calls.map((args) => format(...args)).join("\n"),
    ).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.urlPath).toBe(
        "https://test-mock-api.danskebank.com/[redacted]/[redacted]/[redacted]",
      );
      expect(line.queryKeys).toEqual(["token"]);
      expect(line.targetTier).toBe("mock");
    }
    expect(lines[1].error).toBe("upstream");
  });

  it("preserves the custom AuditLogger event fields and original URL", async () => {
    const url =
      "https://test-mock-api.danskebank.com/accounts/customer?token=private-value";
    const events: AuditEvent[] = [];
    const auditLogger: AuditLogger = {
      async logToolCall(event) {
        events.push(event);
      },
      async logToolResult(event) {
        events.push(event);
      },
    };
    const { client } = await setupClient({ auditLogger });

    await client.callTool({
      name: "call_endpoint",
      arguments: { method: "GET", url },
    });

    expect(Object.keys(events[0]).sort()).toEqual([
      "apiCall",
      "context",
      "timestamp",
      "tool",
    ]);
    expect(Object.keys(events[1]).sort()).toEqual([
      "apiCall",
      "context",
      "result",
      "timestamp",
      "tool",
    ]);
    expect(events[0].apiCall).toEqual({
      method: "GET",
      url,
      targetTier: "mock",
    });
    expect(events[1].apiCall).toEqual(events[0].apiCall);
    expect(events[0].timestamp).toBeInstanceOf(Date);
    expect(events[0].context).toMatchObject({
      env: "test",
      requestId: expect.any(Number),
    });
    expect(events[1].result).toMatchObject({
      durationMs: expect.any(Number),
      statusCode: 200,
    });
  });

  it("does not print an audit sink's raw error", async () => {
    const sentinel = "private-audit-sentinel-123";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auditLogger: AuditLogger = {
      logToolCall: vi.fn().mockRejectedValue(new Error(sentinel)),
      logToolResult: vi.fn().mockRejectedValue(new Error(sentinel)),
    };
    const { client } = await setupClient({ auditLogger });

    const result = await client.callTool({
      name: "call_endpoint",
      arguments: { method: "GET", url: "/accounts", tier: "mock" },
    });

    expect(result.isError).toBeFalsy();
    expect(
      log.mock.calls.map((args) => format(...args)).join("\n"),
    ).not.toContain(sentinel);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("does not expose an upstream tool exception through JSON-RPC or audit", async () => {
    const sentinel = "private-upstream-sentinel-123";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = makeUpstream({
      callTool: vi.fn().mockRejectedValue(new Error(sentinel)),
    });
    const { client } = await setupClient({
      upstream,
      auditLogger: new ConsoleAuditLogger(),
    });

    const call = client.callTool({ name: "search_apis", arguments: {} });
    await expect(call).rejects.toThrow(/upstream/i);
    await expect(call).rejects.not.toThrow(sentinel);
    expect(
      log.mock.calls.map((args) => format(...args)).join("\n"),
    ).not.toContain(sentinel);
  });

  it("does not expose an upstream tools/list exception", async () => {
    const sentinel = "private-list-sentinel-123";
    const upstream = makeUpstream({
      listTools: vi.fn().mockRejectedValue(new Error(sentinel)),
    });
    const { client } = await setupClient({ upstream });

    const list = client.listTools();
    await expect(list).rejects.not.toThrow(sentinel);
    await expect(list).rejects.toThrow(/upstream/i);
  });

  it("does not log a forwarded error response body", async () => {
    const sentinel = "private-result-sentinel-123";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = makeUpstream({
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: sentinel }],
        structuredContent: { error: sentinel },
        isError: true,
      }),
    });
    const { client } = await setupClient({
      upstream,
      auditLogger: new ConsoleAuditLogger(),
    });

    const result = await client.callTool({
      name: "search_apis",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(
      log.mock.calls.map((args) => format(...args)).join("\n"),
    ).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("preserves a forwarded error's HTTP status for custom loggers without copying private metadata", async () => {
    const sentinel = "private-forwarded-metadata-123";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: AuditEvent[] = [];
    const consoleLogger = new ConsoleAuditLogger();
    const auditLogger: AuditLogger = {
      async logToolCall(event) {
        events.push(event);
        await consoleLogger.logToolCall(event);
      },
      async logToolResult(event) {
        events.push(event);
        await consoleLogger.logToolResult(event);
      },
    };
    const upstream = makeUpstream({
      callTool: vi.fn().mockResolvedValue({
        _meta: { statusCode: 429, privateDetails: sentinel },
        content: [{ type: "text", text: sentinel }],
        structuredContent: { error: sentinel },
        isError: true,
      }),
    });
    const { client, server } = await setupClient({ upstream, auditLogger });
    try {
      const result = await client.callTool({
        name: "search_apis",
        arguments: {},
      });

      expect(events[1].result?.statusCode).toBe(429);
      expect(result._meta).toEqual({ statusCode: 429 });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(
        log.mock.calls.map((args) => format(...args)).join("\n"),
      ).not.toContain(sentinel);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not treat a non-numeric forwarded status as HTTP metadata", async () => {
    const events: AuditEvent[] = [];
    const upstream = makeUpstream({ callTool: vi.fn().mockResolvedValue({
      _meta: { statusCode: "private-status-123" },
      content: [{ type: "text", text: "private-error-123" }],
      isError: true,
    }) });
    const { client, server } = await setupClient({ upstream, auditLogger: {
      async logToolCall(event) { events.push(event); },
      async logToolResult(event) { events.push(event); },
    } });
    try {
      const result = await client.callTool({ name: "search_apis", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result._meta).toBeUndefined();
      expect(events[1].result?.statusCode).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("private-");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("builds apiCall details only for destinations call_endpoint accepts", async () => {
    const events: AuditEvent[] = [];
    const auditLogger: AuditLogger = {
      logToolCall: vi.fn(async (e) => {
        events.push(e);
      }),
      logToolResult: vi.fn(async () => {}),
    };
    const { client, server } = await setupClient({ auditLogger });

    try {
      await client.callTool({
        name: "call_endpoint",
        arguments: {
          method: "GET",
          url: "https://user:secret@test-mock-api.danskebank.com/foo",
        },
      });
      await client.callTool({
        name: "call_endpoint",
        arguments: { method: "GET", url: "https://test-mock-api.danskebank.com/foo" },
      });

      expect(events[0]?.apiCall).toBeUndefined();
      expect(events[1]?.apiCall).toEqual({
        method: "GET",
        url: "https://test-mock-api.danskebank.com/foo",
        targetTier: "mock",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
