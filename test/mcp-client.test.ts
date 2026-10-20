import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpClient } from "../src/clients/mcp-client.js";
import { PACKAGE_VERSION } from "../src/version.js";

vi.mock("../src/version.js", () => ({ PACKAGE_VERSION: "9.8.7-rc.42" }));

describe("McpClient", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
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
});
