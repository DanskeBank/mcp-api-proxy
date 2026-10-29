import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { format } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../src/version.js", () => ({ PACKAGE_VERSION: "9.8.7-rc.42" }));

const connect = vi.hoisted(() => vi.fn<() => Promise<void>>());

// Stub McpClient so createServer doesn't attempt a real network connect
// (its 3×2s retry loop would dominate the test runtime).
vi.mock("../src/clients/mcp-client.js", () => {
  class MockMcpClient {
    async connect() { return connect(); }
    async close() {}
    getServerInstructions() {
      return "";
    }
    async listTools() {
      return [];
    }
    async callTool() {
      return { content: [] };
    }
  }
  return { McpClient: MockMcpClient };
});

import { createServer } from "../src/server.js";
import type { Config } from "../src/config/config.js";
import { ProxyError } from "../src/errors.js";
import { getToolDescription } from "../src/tools/call-endpoint.js";
import { PACKAGE_VERSION } from "../src/version.js";

const ENV_KEYS = [
  "MCP_ENV",
  "CLIENT_ID",
  "CLIENT_CERT_PEM",
  "CLIENT_KEY_PEM",
];

function programmaticConfig(): Config {
  return {
    env: "test",
    mcpServerUrl: "https://upstream.invalid/mcp",
    apiHosts: {
      mock: "mock-api.invalid",
      live: "api.invalid",
    },
    tokenScope: "accounts",
  };
}

describe("createServer({ config })", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    connect.mockReset().mockResolvedValue(undefined);
    originalEnv = {};
    for (const k of ENV_KEYS) {
      originalEnv[k] = process.env[k];
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses the provided config and ignores environment variables", async () => {
    // An invalid MCP_ENV would cause getConfig() to throw — proving that
    // a successful createServer call here did NOT call getConfig().
    process.env.MCP_ENV = "definitely-not-valid";

    const handle = await createServer({ config: programmaticConfig() });

    expect(handle.server).toBeDefined();
    await handle.close();
  });

  it("returns a handle that can be closed cleanly", async () => {
    const handle = await createServer({ config: programmaticConfig() });
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("advertises the runtime package version in serverInfo", async () => {
    const handle = await createServer({ config: programmaticConfig() });
    const client = new Client({ name: "version-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getServerVersion()).toEqual({
        name: "danske-api-proxy",
        version: PACKAGE_VERSION,
      });
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it("does not construct a TokenManager when no auth tier is configured", async () => {
    // No sandbox / live in programmaticConfig() → no TokenManager instantiated.
    // close() must succeed even though no tokenManager was created.
    const handle = await createServer({ config: programmaticConfig() });
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it.each(["mock", "sandbox", "live"] as const)(
    "reports usable tiers and the actual %s default on stderr",
    async (tier) => {
      const config = programmaticConfig();
      config.apiHosts.sandbox = "sandbox-api.invalid";
      const auth = {
        certPath: "/example/cert.pem",
        keyPath: "/example/key.pem",
        tokenUrl: "https://auth.invalid/token",
      };
      if (tier !== "mock") config.sandbox = auth;
      if (tier === "live") config.live = auth;
      const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
      const handle = await createServer({ config });

      try {
        const tiers = tier === "mock" ? "mock" : tier === "sandbox" ? "mock,sandbox" : "mock,sandbox,live";
        const calls = vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
        expect(calls).toContain(`enabled-tiers=${tiers} default-tier=${tier}`);
        expect(calls.includes("default uses real data")).toBe(tier === "live");
        expect(getToolDescription(config)).toContain(`Default tier: ${tier}.`);
        expect(stdout).not.toHaveBeenCalled();
      } finally {
        await handle.close();
      }
    },
  );

  it("does not advertise an authenticated tier whose host is unavailable", async () => {
    const config = programmaticConfig();
    delete config.apiHosts.live;
    config.live = {
      certPath: "/example/cert.pem",
      keyPath: "/example/key.pem",
      tokenUrl: "https://auth.invalid/token",
    };
    const handle = await createServer({ config });

    try {
      const calls = vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
      expect(calls).toContain("enabled-tiers=mock default-tier=mock");
      expect(calls).not.toContain("live=on");
      expect(calls).not.toContain("default uses real data");
    } finally {
      await handle.close();
    }
  });

  it("reports a missing hosted MCP server API key at startup", async () => {
    const handle = await createServer({ config: programmaticConfig() });

    try {
      const calls = vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
      expect(calls).toContain("mcp-api-key=missing");
      expect(calls).not.toContain("mcp-api-key=on");
    } finally {
      await handle.close();
    }
  });

  it("reports a configured hosted MCP server API key without its value", async () => {
    const handle = await createServer({
      config: { ...programmaticConfig(), mcpServerApiKey: "private-api-key-8675309" },
    });

    try {
      const calls = vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
      expect(calls).toContain("mcp-api-key=on");
      expect(calls).not.toContain("mcp-api-key=missing");
      expect(calls).not.toContain("private-api-key-8675309");
    } finally {
      await handle.close();
    }
  });

  it("reports when the fallback default has no usable host", async () => {
    const config = programmaticConfig();
    config.apiHosts = { mock: "" };
    const handle = await createServer({ config });

    try {
      const calls = vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
      expect(calls).toContain("enabled-tiers=none default-tier=mock (unavailable)");
    } finally {
      await handle.close();
    }
  });

  it("ignores partial environment credentials when configuration is supplied programmatically", async () => {
    process.env.CLIENT_ID = "private-ignored-client-8675309";
    delete process.env.CLIENT_CERT_PEM;
    delete process.env.CLIENT_KEY_PEM;
    const handle = await createServer({ config: programmaticConfig() });

    try {
      const calls = vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
      expect(calls).toContain("enabled-tiers=mock default-tier=mock");
      expect(calls).not.toContain("incomplete");
      expect(calls).not.toContain("private-ignored-client-8675309");
    } finally {
      await handle.close();
    }
  });

  it("does not print credentials, paths or query values from startup settings", async () => {
    const sentinel = "private-startup-sentinel-8675309";
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), sentinel));
    const caPath = path.join(directory, "example.pem");
    fs.writeFileSync(caPath, "example-test-ca");
    const config = programmaticConfig();
    config.mcpServerUrl = `https://user:${sentinel}@upstream.invalid/${sentinel}?token=${sentinel}`;
    config.extraCaCertPath = caPath;
    config.mcpServerApiKey = sentinel;
    const handle = await createServer({ config });
    try {
      const calls = vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
      expect(calls).not.toContain(sentinel);
      expect(calls).toContain("https://upstream.invalid/[redacted]");
    } finally {
      await handle.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { category: "auth", hint: "The hosted MCP server rejected MCP_SERVER_API_KEY. Check the key." },
    { category: "rate_limited", hint: "Too many invalid API key attempts. Wait, then restart the proxy." },
  ] as const)(
    "reports a $category upstream refusal once, without retrying, to the user and the agent",
    async ({ category, hint }) => {
      const key = "private-api-key-8675309";
      connect.mockRejectedValue(new ProxyError(category, { hint }));
      const handle = await createServer({ config: { ...programmaticConfig(), mcpServerApiKey: key } });
      const client = new Client({ name: "key-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      try {
        await handle.server.connect(serverTransport);
        await client.connect(clientTransport);
        expect(handle.mcpClient).toBeNull();
        expect(connect).toHaveBeenCalledTimes(1);

        const calls = vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
        expect(calls).toContain(`[${category}]`);
        expect(calls).toContain(hint);
        expect(calls).not.toContain("connect attempt");
        expect(calls).not.toContain(key);

        expect(client.getInstructions()).toContain(hint);
        const result = await client.callTool({ name: "search_apis", arguments: {} });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(hint);
      } finally {
        await client.close();
        await handle.close();
      }
    },
  );

  it("keeps retrying other connection failures and adds no instructions for them", async () => {
    vi.useFakeTimers();
    connect.mockRejectedValue(new Error("connection reset"));
    const creation = createServer({ config: programmaticConfig() });
    await vi.runAllTimersAsync();
    const handle = await creation;
    const client = new Client({ name: "retry-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(connect).toHaveBeenCalledTimes(3);
      expect(client.getInstructions()).toBeUndefined();
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it("tells the agent about a temporary key verification failure once the retries are used up", async () => {
    vi.useFakeTimers();
    const hint = "The hosted MCP server could not verify the API key right now.";
    connect.mockRejectedValue(new ProxyError("upstream", { hint }));
    const creation = createServer({ config: programmaticConfig() });
    await vi.runAllTimersAsync();
    const handle = await creation;
    const client = new Client({ name: "transient-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(connect).toHaveBeenCalledTimes(3);
      expect(client.getInstructions()).toContain(hint);

      const result = await client.callTool({ name: "search_apis", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result._meta).toEqual({ errorCategory: "upstream" });
      expect(JSON.stringify(result.content)).toContain(hint);
      expect(JSON.stringify(result.content)).not.toContain("not connected");
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it("keeps raw upstream connection errors out of retry and fallback logs", async () => {
    vi.useFakeTimers();
    const sentinel = "private-connection-sentinel-8675309";
    connect.mockRejectedValue(new Error(sentinel));
    const creation = createServer({ config: programmaticConfig() });
    await vi.runAllTimersAsync();
    const handle = await creation;
    try {
      expect(handle.mcpClient).toBeNull();
      expect(connect).toHaveBeenCalledTimes(3);
      const calls = vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
      expect(calls).not.toContain(sentinel);
      expect(calls).toContain("[upstream]");
    } finally {
      await handle.close();
    }
  });
});
