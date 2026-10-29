import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { format } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpClient, classifyUpstreamError } from "../src/clients/mcp-client.js";
import { resetKeyRefusals } from "../src/clients/key-refusal.js";
import type { Config } from "../src/config/config.js";
import { ProxyError } from "../src/errors.js";
import { createServer } from "../src/server.js";
import { PACKAGE_VERSION } from "../src/version.js";

vi.mock("../src/version.js", () => ({ PACKAGE_VERSION: "9.8.7-rc.42" }));

interface JsonRpcRequest {
  id?: number;
  method?: string;
  params?: { protocolVersion?: string };
}

async function readJsonRpc(req: http.IncomingMessage): Promise<JsonRpcRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as JsonRpcRequest;
}

function sendJson(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** Mirrors the hosted server: HTTP 200 with a JSON-RPC -32001 error whose data is a string. */
function sendKeyRejection(res: http.ServerResponse, id: number | undefined, message: string): void {
  sendJson(res, {
    jsonrpc: "2.0",
    id,
    error: { code: -32001, message, data: "private-upstream-detail" },
  });
}

describe("McpClient", () => {
  let server: http.Server | undefined;

  beforeEach(() => {
    resetKeyRefusals();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  function listen(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<string> {
    return new Promise((resolve) => {
      server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server!.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}/mcp`);
      });
    });
  }

  it("sends the runtime package version in upstream clientInfo", async () => {
    const upstream = new McpServer({ name: "catalog", version: "1.0.0" });
    upstream.registerTool(
      "fixture_discovery",
      { description: "Loopback-only discovery fixture" },
      async () => ({ content: [] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => "version-test-session",
      enableJsonResponse: true,
    });
    await upstream.connect(transport);
    const url = await listen((req, res) => {
      transport.handleRequest(req, res).catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : new Error("MCP request failed"));
      });
    });
    const client = new McpClient(url);

    try {
      await client.connect();
      expect(upstream.server.getClientVersion()).toEqual({
        name: "danske-mcp-api-proxy",
        version: PACKAGE_VERSION,
      });
      expect((await client.listTools()).map((tool) => tool.name)).toContain("fixture_discovery");
    } finally {
      await client.close();
      await upstream.close();
    }
  });

  it("sends X-API-Key on the upstream request when apiKey is configured", async () => {
    let capturedHeader: string | undefined;
    const url = await listen((req, res) => {
      capturedHeader = req.headers["x-api-key"] as string | undefined;
      res.writeHead(500);
      res.end();
    });

    const client = new McpClient(url, { apiKey: "test-api-key" });
    await expect(client.connect()).rejects.toBeTruthy();
    expect(capturedHeader).toBe("test-api-key");
    await client.close();
  });

  it("sends no X-API-Key header when apiKey is not configured", async () => {
    let sawHeader = false;
    const url = await listen((req, res) => {
      sawHeader = "x-api-key" in req.headers;
      res.writeHead(500);
      res.end();
    });

    const client = new McpClient(url);
    await expect(client.connect()).rejects.toBeTruthy();
    expect(sawHeader).toBe(false);
    await client.close();
  });

  describe("hosted API key rejection", () => {
    const key = "private-api-key-8675309";

    it.each([
      {
        label: "a rejected key",
        message: "The provided API key is not valid.",
        apiKey: key,
        category: "auth",
        text: "rejected MCP_SERVER_API_KEY",
      },
      {
        label: "a missing key",
        message: "X-API-Key header is required.",
        apiKey: undefined,
        category: "auth",
        text: "MCP_SERVER_API_KEY is not set",
      },
      {
        label: "too many invalid attempts",
        message: "Too many invalid API key attempts.",
        apiKey: key,
        category: "rate_limited",
        text: "too many invalid API key attempts",
      },
      {
        label: "a temporary key service failure",
        message: "The API key could not be verified right now.",
        apiKey: key,
        category: "upstream",
        text: "could not verify the API key right now",
      },
    ])("explains $label on connect without echoing upstream text or the key", async (c) => {
      const url = await listen(async (req, res) => {
        const body = await readJsonRpc(req);
        sendKeyRejection(res, body.id, c.message);
      });
      const client = new McpClient(url, { apiKey: c.apiKey });

      const error = await client.connect().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ProxyError);
      const proxyError = error as ProxyError;
      expect(proxyError.category).toBe(c.category);
      expect(proxyError.message).toContain(c.text);
      expect(proxyError.message).not.toContain(key);
      expect(proxyError.message).not.toContain("private-upstream-detail");
      await client.close();
    });

    it.each([401, 403])("explains an HTTP %i from a gateway in front of the server", async (status) => {
      const url = await listen((_req, res) => {
        res.writeHead(status);
        res.end("private-gateway-body");
      });
      const client = new McpClient(url, { apiKey: key });

      const error = await client.connect().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ProxyError);
      const proxyError = error as ProxyError;
      expect(proxyError.category).toBe("auth");
      expect(proxyError.statusCode).toBe(status);
      expect(proxyError.message).toContain(`HTTP ${status}`);
      expect(proxyError.message).toContain("rejected MCP_SERVER_API_KEY");
      expect(proxyError.message).not.toContain("private-gateway-body");
      await client.close();
    });

    it("tells a client without a key that MCP_SERVER_API_KEY is not set on an HTTP 401", async () => {
      const url = await listen((_req, res) => {
        res.writeHead(401);
        res.end("private-gateway-body");
      });
      const client = new McpClient(url);

      const error = await client.connect().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ProxyError);
      const proxyError = error as ProxyError;
      expect(proxyError.category).toBe("auth");
      expect(proxyError.statusCode).toBe(401);
      expect(proxyError.message).toContain("MCP_SERVER_API_KEY is not set");
      expect(proxyError.message).not.toContain("private-gateway-body");
      await client.close();
    });

    it("explains a key that is revoked after the connection was established", async () => {
      let rejections = 0;
      const url = await listen(async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonRpc(req);
        if (body.method === "initialize") {
          sendJson(res, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: body.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1.0.0" },
            },
          });
        } else if (body.id === undefined) {
          res.writeHead(202);
          res.end();
        } else {
          rejections += 1;
          sendKeyRejection(res, body.id, "The provided API key is not valid.");
        }
      });
      const client = new McpClient(url, { apiKey: key });

      try {
        await client.connect();
        await expect(client.listTools()).rejects.toThrow(/\[auth\].*rejected MCP_SERVER_API_KEY/);
        await expect(client.callTool("search_apis", {})).rejects.toThrow(
          /\[auth\].*rejected MCP_SERVER_API_KEY/,
        );
        expect(rejections).toBe(1);
      } finally {
        await client.close();
      }
    });
  });

  describe("remembering a refused key", () => {
    const key = "private-api-key-8675309";

    async function rejectingServer(message: string) {
      const counter = { requests: 0 };
      const url = await listen(async (req, res) => {
        const body = await readJsonRpc(req);
        counter.requests += 1;
        sendKeyRejection(res, body.id, message);
      });
      return { url, counter };
    }

    async function connectOnce(url: string, apiKey?: string): Promise<unknown> {
      const client = new McpClient(url, { apiKey });
      try {
        return await client.connect().then(() => undefined, (err: unknown) => err);
      } finally {
        await client.close();
      }
    }

    it.each([
      { label: "a rejected key", message: "The provided API key is not valid.", text: "rejected MCP_SERVER_API_KEY" },
      { label: "too many invalid attempts", message: "Too many invalid API key attempts.", text: "too many invalid API key attempts" },
    ])("does not send $label to the same server again", async ({ message, text }) => {
      const { url, counter } = await rejectingServer(message);

      const first = await connectOnce(url, key);
      const second = await connectOnce(url, key);

      expect(first).toBeInstanceOf(ProxyError);
      expect(second).toBeInstanceOf(ProxyError);
      expect((second as ProxyError).message).toContain(text);
      expect(counter.requests).toBe(1);
    });

    it("sends a different key", async () => {
      const { url, counter } = await rejectingServer("The provided API key is not valid.");

      await connectOnce(url, key);
      await connectOnce(url, "another-private-key");

      expect(counter.requests).toBe(2);
    });

    it("tries again once the remembered refusal has expired", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { url, counter } = await rejectingServer("The provided API key is not valid.");

      await connectOnce(url, key);
      vi.setSystemTime(Date.now() + 59_000);
      await connectOnce(url, key);
      expect(counter.requests).toBe(1);

      vi.setSystemTime(Date.now() + 2_000);
      await connectOnce(url, key);
      expect(counter.requests).toBe(2);
    });

    it("does not remember a temporary key verification failure", async () => {
      const { url, counter } = await rejectingServer("The API key could not be verified right now.");

      await connectOnce(url, key);
      await connectOnce(url, key);

      expect(counter.requests).toBe(2);
    });

    it("sends the key once across the sessions of an HTTP proxy", async () => {
      const { url, counter } = await rejectingServer("The provided API key is not valid.");
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      const config: Config = {
        env: "test",
        mcpServerUrl: url,
        apiHosts: { mock: "mock-api.invalid", live: "api.invalid" },
        tokenScope: "accounts",
        mcpServerApiKey: key,
      };
      const first = await createServer({ config });
      const second = await createServer({ config });
      const client = new Client({ name: "session-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      try {
        await second.server.connect(serverTransport);
        await client.connect(clientTransport);
        expect(counter.requests).toBe(1);
        expect(first.mcpClient).toBeNull();
        expect(second.mcpClient).toBeNull();
        expect(client.getInstructions()).toContain("rejected MCP_SERVER_API_KEY");
        const calls = stderr.mock.calls.map((args) => format(...args)).join("\n");
        expect(calls).not.toContain(key);
      } finally {
        await client.close();
        await first.close();
        await second.close();
        stderr.mockRestore();
      }
    });
  });
});

describe("classifyUpstreamError", () => {
  it("leaves unrelated errors alone", () => {
    expect(classifyUpstreamError(new Error("boom"), true)).toBeUndefined();
    expect(classifyUpstreamError(new StreamableHTTPError(500, "down"), true)).toBeUndefined();
    expect(
      classifyUpstreamError(new McpError(ErrorCode.InvalidParams, "The API key field is bad"), true),
    ).toBeUndefined();
  });

  it("does not mistake an SDK request timeout (also -32001) for a rejected key", () => {
    const timeout = new McpError(ErrorCode.RequestTimeout, "Request timed out", { timeout: 60000 });
    expect(classifyUpstreamError(timeout, true)).toBeUndefined();
  });

  it("falls back to the rejected-key explanation for unknown API key wording", () => {
    const unknown = new McpError(ErrorCode.RequestTimeout, "Your API key is on a blocklist");
    expect(classifyUpstreamError(unknown, true)?.message).toContain("rejected MCP_SERVER_API_KEY");
  });
});
