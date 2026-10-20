import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const TSX_CLI = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
);
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function cliEnvironment(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

describe("CLI --settings-file", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-cli-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-cli-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  /** Starts the CLI from an empty working directory with literal args, as MCP clients pass them (no shell). */
  function runCli(args: string[]) {
    return spawnSync(process.execPath, [TSX_CLI, ENTRY, ...args], {
      cwd,
      // A clean environment, so nothing from the developer's shell masks the file.
      env: cliEnvironment(home),
      encoding: "utf8",
      timeout: 20_000,
    });
  }

  function writeSettings(content: string): string {
    const file = path.join(home, "danske-proxy.env");
    fs.writeFileSync(file, content);
    return file;
  }

  it("loads the settings file from another working directory without printing its values", () => {
    const file = writeSettings(
      "MCP_HTTP_PORT=settings-file-probe\nCLIENT_KEY_PASSPHRASE=sentinel-passphrase-123\n",
    );
    const run = runCli(["--transport", "http", "--settings-file", file]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`[proxy] settings loaded from ${file}`);
    expect(run.stderr).toContain("[configuration]: Invalid MCP_HTTP_PORT.");
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toContain("settings-file-probe");
    expect(run.stderr).not.toContain("sentinel-passphrase-123");
  }, 30_000);

  it("expands a literal ~/ path to the home directory", () => {
    const file = writeSettings("MCP_HTTP_PORT=home-probe\n");
    const run = runCli(["--transport", "http", "--settings-file", "~/danske-proxy.env"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`[proxy] settings loaded from ${file}`);
    expect(run.stderr).toContain("[configuration]: Invalid MCP_HTTP_PORT.");
    expect(run.stderr).not.toContain("home-probe");
  }, 30_000);

  it("stops with its own message when the settings file is missing", () => {
    const missing = path.join(home, "missing-private-path-123.env");
    const run = runCli(["--settings-file", missing]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "[configuration]: Cannot read the settings file (ENOENT).",
    );
    expect(run.stderr).toContain("Check the path after --settings-file");
    expect(run.stderr).not.toContain(missing);
    expect(run.stdout).toBe("");
  }, 30_000);

  it("reads the HTTP port from the settings file in HTTP mode", () => {
    // An invalid port stops startup before anything binds or connects.
    const file = writeSettings("MCP_HTTP_PORT=not-a-port\n");
    const run = runCli(["--transport", "http", "--settings-file", file]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("[configuration]: Invalid MCP_HTTP_PORT.");
    expect(run.stderr).not.toContain("not-a-port");
    expect(run.stdout).toBe("");
  }, 30_000);

  it.each([false, true])(
    "reports tiers before the first HTTP session, with partial credentials: %s",
    async (partial) => {
      const occupied = createServer();
      await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
      try {
        const address = occupied.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP address");
        const sentinel = "private-http-startup-8675309";
        const file = writeSettings(
          `MCP_ENV=prod\nMCP_HTTP_PORT=${address.port}\n` +
          (partial ? `CLIENT_ID=${sentinel}\n` : ""),
        );
        const run = runCli(["--transport", "http", "--settings-file", file]);

        expect(run.error).toBeUndefined();
        expect(run.status).toBe(1);
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("enabled-tiers=mock default-tier=mock");
        expect(run.stderr.includes("incomplete live authentication")).toBe(partial);
        expect(run.stderr.includes("incomplete sandbox authentication")).toBe(partial);
        expect(run.stderr).not.toContain(sentinel);
        expect(run.stderr).not.toContain("upstream connect");
      } finally {
        await new Promise<void>((resolve, reject) =>
          occupied.close((error) => error ? reject(error) : resolve()),
        );
      }
    },
    30_000,
  );

  it.each([
    "MCP_MAX_SESSIONS",
    "MCP_SESSION_TTL_MS",
    "MCP_RATE_LIMIT_PER_IP",
    "MCP_RATE_LIMIT_WINDOW_MS",
  ])("names %s without exposing its invalid value", (name) => {
    const file = writeSettings(`${name}=private-setting-value-123\n`);
    const run = runCli(["--transport", "http", "--settings-file", file]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`[configuration]: Invalid ${name}.`);
    expect(run.stderr).not.toContain("private-setting-value-123");
    expect(run.stdout).toBe("");
  }, 30_000);

  it("names a missing settings-file argument without printing a stack trace", () => {
    const run = runCli(["--settings-file"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("[configuration]: --settings-file needs a path");
    expect(run.stderr).not.toContain("\n    at ");
    expect(run.stdout).toBe("");
  }, 30_000);

  it("starts a fresh stdio process, discovers tools and shuts down without protocol or secret leakage", async () => {
    const upstream = new McpServer({ name: "synthetic-catalog", version: "1.0.0" });
    upstream.registerTool("get_filters", {}, async () => ({
      content: [{ type: "text", text: '{"environments":["test"]}' }],
    }));
    const upstreamTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    });
    await upstream.connect(upstreamTransport);
    const requestErrors: unknown[] = [];
    const apiKeys: Array<string | string[] | undefined> = [];
    const http = createHttpServer((request, response) => {
      apiKeys.push(request.headers["x-api-key"]);
      void upstreamTransport.handleRequest(request, response).catch((error) => {
        requestErrors.push(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const apiKey = "synthetic-catalog-key";
    const file = writeSettings(
      `MCP_ENV=test\nMCP_SERVER_URL=http://127.0.0.1:${address.port}/mcp\n` +
      `MCP_API_HOST_MOCK=mock.example.test\nMCP_SERVER_API_KEY=${apiKey}\n`,
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
        ENTRY,
        "--settings-file",
        file,
      ],
      cwd,
      env: cliEnvironment(home),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const client = new Client({ name: "fresh-process-test", version: "1.0.0" });
    const protocolErrors: Error[] = [];
    client.onerror = (error) => protocolErrors.push(error);
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["call_endpoint", "get_filters"]),
      );
      const result = await client.callTool({ name: "get_filters", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: '{"environments":["test"]}' }]);
      const pid = transport.pid;
      if (pid === null) throw new Error("Expected a running CLI child process");

      await client.close();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/));
      expect(stderr).toContain("enabled-tiers=mock default-tier=mock");
      expect(stderr).not.toContain(apiKey);
      expect(stderr).not.toContain("incomplete");
      expect(protocolErrors).toEqual([]);
      expect(requestErrors).toEqual([]);
      expect(apiKeys.length).toBeGreaterThan(0);
      expect(apiKeys.every((key) => key === apiKey)).toBe(true);
    } finally {
      await client.close();
      await upstream.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => error ? reject(error) : resolve()),
      );
    }
  }, 30_000);

  it("does not echo an invalid transport", () => {
    const run = runCli(["--transport", "private-transport-123"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("[configuration]: Unknown transport. Supported: stdio, http.");
    expect(run.stderr).not.toContain("private-transport-123");
    expect(run.stdout).toBe("");
  }, 30_000);
});
