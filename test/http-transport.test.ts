import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  request as requestHttp,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { setImmediate } from "node:timers/promises";
import { format } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createHttpSessionHandler,
  createLoopbackHostCheck,
  createLoopbackOriginCheck,
  type HttpSessionHandlerOptions,
} from "../src/http-transport.js";
import type { Config } from "../src/config/config.js";
import { createServer, type ProxyHandle } from "../src/server.js";
import { TokenManager } from "../src/auth/token-manager.js";

vi.mock("../src/server.js", () => ({ createServer: vi.fn() }));

/**
 * Minimal config that exercises the no-auth path: no `sandbox`/`live`
 * tier, so the handler does not construct a `TokenManager` from env.
 */
function makeFakeConfig(): Config {
  return {
    env: "test",
    mcpServerUrl: "https://example.invalid/mcp",
    apiHosts: {
      mock: "mock-api.example.invalid",
      live: "api.example.invalid",
    },
    tokenScope: "accounts",
  };
}

function makeReq(
  opts: {
    headers?: Record<string, string>;
    remoteAddress?: string;
    url?: string;
  } = {},
): IncomingMessage {
  return {
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
    url: opts.url ?? "/mcp",
  } as unknown as IncomingMessage;
}

function makeRes(): {
  res: ServerResponse;
  status: () => number | undefined;
  body: () => string;
} {
  let statusCode: number | undefined;
  let body = "";
  const res = {
    headersSent: false,
    writeHead(code: number) {
      statusCode = code;
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
      return res;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => statusCode,
    body: () => body,
  };
}

describe("createHttpSessionHandler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns 404 for an unknown session id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHttpSessionHandler({
      proxyOptions: { config: makeFakeConfig() },
    });
    const { res, status, body } = makeRes();

    await handler.handleRequest(
      makeReq({ headers: { "mcp-session-id": "does-not-exist" } }),
      res,
    );

    expect(status()).toBe(404);
    expect(JSON.parse(body())).toEqual({ error: "Session not found" });
    await handler.closeAll();
  });

  it("rejects with 503 when the session cap is exhausted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // maxSessions=0 means the first request hits the cap before any
    // upstream session creation is attempted.
    const handler = createHttpSessionHandler({
      maxSessions: 0,
      proxyOptions: { config: makeFakeConfig() },
    });
    const { res, status, body } = makeRes();

    await handler.handleRequest(makeReq(), res);

    expect(status()).toBe(503);
    expect(JSON.parse(body()).error).toMatch(/Too many active sessions/);
    expect(handler.activeSessionCount).toBe(0);
    await handler.closeAll();
  });

  it("rejects with 429 when the per-IP rate limit is exceeded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // rateLimitPerIp=0 makes every request rate-limited before creation.
    const handler = createHttpSessionHandler({
      rateLimitPerIp: 0,
      proxyOptions: { config: makeFakeConfig() },
    });
    const { res, status, body } = makeRes();

    await handler.handleRequest(makeReq(), res);

    expect(status()).toBe(429);
    expect(JSON.parse(body()).error).toMatch(/Rate limit exceeded/);
    expect(handler.activeSessionCount).toBe(0);
    await handler.closeAll();
  });

  it("trustProxy uses X-Forwarded-For to determine client IP", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHttpSessionHandler({
      rateLimitPerIp: 0,
      trustProxy: true,
      proxyOptions: { config: makeFakeConfig() },
    });
    // First request from spoofed IP A → rejected (rate limit 0).
    {
      const { res, status } = makeRes();
      await handler.handleRequest(
        makeReq({
          remoteAddress: "10.0.0.1",
          headers: { "x-forwarded-for": "203.0.113.1, 198.51.100.1" },
        }),
        res,
      );
      expect(status()).toBe(429);
    }
    // Second request from a different XFF still rejected — confirms the
    // path is exercised regardless of the underlying socket.
    {
      const { res, status } = makeRes();
      await handler.handleRequest(
        makeReq({
          remoteAddress: "10.0.0.1",
          headers: { "x-forwarded-for": "203.0.113.2" },
        }),
        res,
      );
      expect(status()).toBe(429);
    }
    await handler.closeAll();
  });

  it("starts with zero active sessions", () => {
    const handler = createHttpSessionHandler({
      proxyOptions: { config: makeFakeConfig() },
    });
    expect(handler.activeSessionCount).toBe(0);
    return handler.closeAll();
  });

  it("closeAll resolves cleanly with no sessions", async () => {
    const handler = createHttpSessionHandler({
      proxyOptions: { config: makeFakeConfig() },
    });
    await expect(handler.closeAll()).resolves.toBeUndefined();
  });
});

describe("HTTP session lifecycle with the MCP SDK", () => {
  interface HttpFixture {
    handler: ReturnType<typeof createHttpSessionHandler>;
    httpServer: ReturnType<typeof createHttpServer>;
    arrivals: { req: IncomingMessage; res: ServerResponse }[];
    pending: Set<Promise<void>>;
    errors: unknown[];
    url: string;
  }

  const fixtures: HttpFixture[] = [];
  const releases: (() => void)[] = [];
  const handles: ProxyHandle[] = [];

  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    releases.push(resolve);
    return { promise, resolve };
  }

  function makeProxyHandle(onCall: () => Promise<void> = async () => {}) {
    const server = new McpServer(
      { name: "lifecycle-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool("wait", {}, async () => {
      await onCall();
      return { content: [{ type: "text", text: "finished" }] };
    });
    const handle: ProxyHandle = {
      server,
      mcpClient: null,
      close: vi.fn(async () => {
        await server.close();
      }),
    };
    handles.push(handle);
    return handle;
  }

  async function startHttpHandler(
    options: HttpSessionHandlerOptions = {},
  ): Promise<HttpFixture> {
    const handler = createHttpSessionHandler({
      maxSessions: 1,
      rateLimitPerIp: 100,
      proxyOptions: { config: makeFakeConfig() },
      ...options,
    });
    const arrivals: { req: IncomingMessage; res: ServerResponse }[] = [];
    const pending = new Set<Promise<void>>();
    const errors: unknown[] = [];
    const httpServer = createHttpServer((req, res) => {
      arrivals.push({ req, res });
      const request = handler.handleRequest(req, res).catch((error) => {
        errors.push(error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      pending.add(request);
      void request.finally(() => pending.delete(request));
    });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback TCP listener");
    }
    const fixture = {
      handler,
      httpServer,
      arrivals,
      pending,
      errors,
      url: `http://127.0.0.1:${address.port}/mcp`,
    };
    fixtures.push(fixture);
    return fixture;
  }

  function post(url: string, message: object, sessionId?: string) {
    return fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(message),
    });
  }

  async function initialize(url: string, clientName = "lifecycle-client") {
    const response = await post(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      },
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("Initialization did not return a session ID");
    return sessionId;
  }

  function callTool(url: string, sessionId: string, id = 2) {
    return post(url, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "wait", arguments: {} },
    }, sessionId);
  }

  function startIncompleteRequest(url: string) {
    const request = requestHttp(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
    });
    request.on("error", vi.fn());
    request.write('{"jsonrpc":');
    return request;
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createServer).mockReset().mockImplementation(async () => makeProxyHandle());
  });

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const fixture of fixtures.splice(0)) {
      await fixture.handler.closeAll();
      fixture.httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        fixture.httpServer.close((error) => error ? reject(error) : resolve());
      });
      await Promise.all(fixture.pending);
    }
    handles.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "GET without a session", method: "GET", status: 400 },
    { name: "tool request before initialize", method: "POST", status: 400,
      body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' },
    { name: "malformed JSON", method: "POST", status: 400, body: "{" },
    { name: "unsupported Accept", method: "POST", status: 406, accept: "application/json", body: "{}" },
    { name: "unsupported Content-Type", method: "POST", status: 415, contentType: "text/plain", body: "{}" },
    { name: "DELETE without a session", method: "DELETE", status: 400 },
    { name: "unsupported method", method: "PUT", status: 405 },
  ])("releases slots and resources after $name", async (rejection) => {
    const fixture = await startHttpHandler({ maxSessions: 2 });
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(fixture.url, {
        method: rejection.method,
        headers: {
          accept: rejection.accept ?? "application/json, text/event-stream",
          "content-type": rejection.contentType ?? "application/json",
        },
        body: rejection.body,
      });
      await response.text();
      expect(response.status).toBe(rejection.status);
      expect(fixture.handler.activeSessionCount).toBe(0);
    }
    await vi.waitFor(() => {
      for (const handle of handles) expect(handle.close).toHaveBeenCalledTimes(1);
    });
    await initialize(fixture.url);
    expect(fixture.handler.activeSessionCount).toBe(1);
    expect(fixture.errors).toEqual([]);
  });

  it("releases a reservation when server creation fails", async () => {
    vi.mocked(createServer).mockRejectedValueOnce(new Error("creation failed"));
    const fixture = await startHttpHandler();
    const rejected = await fetch(fixture.url);
    await rejected.text();
    expect(rejected.status).toBe(500);
    await initialize(fixture.url);
    expect(fixture.handler.activeSessionCount).toBe(1);
    expect(fixture.errors).toHaveLength(1);
  });

  it.each(["connect", "request"] as const)(
    "closes the proxy exactly once after a thrown %s failure",
    async (stage) => {
      const handle = makeProxyHandle();
      vi.mocked(createServer).mockResolvedValueOnce(handle);
      if (stage === "connect") {
        vi.spyOn(handle.server, "connect").mockRejectedValueOnce(new Error("connect failed"));
      } else {
        vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest")
          .mockRejectedValueOnce(new Error("request failed"));
      }
      const fixture = await startHttpHandler();
      const rejected = await fetch(fixture.url);
      await rejected.text();
      expect(rejected.status).toBe(500);
      await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1));
      await initialize(fixture.url);
      expect(fixture.handler.activeSessionCount).toBe(1);
      expect(fixture.errors).toHaveLength(1);
    },
  );

  it("frees a disconnected reservation before server creation finishes", async () => {
    const creating = gate();
    const handle = makeProxyHandle();
    const connect = vi.spyOn(handle.server, "connect");
    vi.mocked(createServer).mockImplementationOnce(async () => {
      await creating.promise;
      return handle;
    });
    const fixture = await startHttpHandler();
    const request = startIncompleteRequest(fixture.url);
    await vi.waitFor(() => expect(fixture.arrivals).toHaveLength(1));
    const closed = once(fixture.arrivals[0].res, "close");
    request.destroy();
    await closed;

    await initialize(fixture.url);
    creating.resolve();
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1));
    expect(connect).not.toHaveBeenCalled();
    expect(fixture.handler.activeSessionCount).toBe(1);
  });

  it("closes a disconnected initialization while the request body is incomplete", async () => {
    const fixture = await startHttpHandler();
    const request = startIncompleteRequest(fixture.url);
    await vi.waitFor(() => expect(handles).toHaveLength(1));
    const closed = once(fixture.arrivals[0].res, "close");
    request.destroy();
    await closed;
    await vi.waitFor(() => expect(handles[0].close).toHaveBeenCalledTimes(1));
    await initialize(fixture.url);
    expect(fixture.handler.activeSessionCount).toBe(1);
  });

  it("reserves capacity while initialization is pending", async () => {
    const creating = gate();
    const handle = makeProxyHandle();
    vi.mocked(createServer).mockImplementationOnce(async () => {
      await creating.promise;
      return handle;
    });
    const fixture = await startHttpHandler();
    const request = startIncompleteRequest(fixture.url);
    await vi.waitFor(() => expect(createServer).toHaveBeenCalledTimes(1));
    const rejected = await fetch(fixture.url);
    await rejected.text();
    expect(rejected.status).toBe(503);
    expect(createServer).toHaveBeenCalledTimes(1);

    const closed = once(fixture.arrivals[0].res, "close");
    request.destroy();
    await closed;
    creating.resolve();
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1));
    await initialize(fixture.url);
  });

  it("waits for a disconnected connect operation before closing its proxy", async () => {
    const connecting = gate();
    const started = gate();
    const handle = makeProxyHandle();
    const connect = handle.server.connect.bind(handle.server);
    vi.spyOn(handle.server, "connect").mockImplementation(async (transport) => {
      started.resolve();
      await connecting.promise;
      await connect(transport);
    });
    vi.mocked(createServer).mockResolvedValueOnce(handle);
    const fixture = await startHttpHandler();
    const request = startIncompleteRequest(fixture.url);
    await started.promise;
    const closed = once(fixture.arrivals[0].res, "close");
    request.destroy();
    await closed;
    expect(handle.close).not.toHaveBeenCalled();

    await initialize(fixture.url);
    connecting.resolve();
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1));
    expect(fixture.handler.activeSessionCount).toBe(1);
  });

  it.each([false, true])(
    "protects a long-running call and starts its idle TTL on completion (tool failure: %s)",
    async (fail) => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const started = gate();
      const complete = gate();
      const handle = makeProxyHandle(async () => {
        started.resolve();
        await complete.promise;
        if (fail) throw new Error("test tool failure");
      });
      vi.mocked(createServer).mockResolvedValueOnce(handle);
      const fixture = await startHttpHandler({ sessionTtlMs: 90_000 });
      const sessionId = await initialize(fixture.url);
      const response = callTool(fixture.url, sessionId);
      await started.promise;

      await vi.advanceTimersByTimeAsync(180_000);
      expect(fixture.handler.activeSessionCount).toBe(1);
      expect(handle.close).not.toHaveBeenCalled();
      complete.resolve();
      const result = await response;
      expect(result.status).toBe(200);
      expect(await result.text()).toContain(fail ? "test tool failure" : "finished");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.handler.activeSessionCount).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.handler.activeSessionCount).toBe(0);
      expect(handle.close).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a session busy until all concurrent calls finish", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const started = [gate(), gate()];
    const complete = [gate(), gate()];
    let call = 0;
    const handle = makeProxyHandle(async () => {
      const index = call++;
      started[index].resolve();
      await complete[index].promise;
    });
    vi.mocked(createServer).mockResolvedValueOnce(handle);
    const fixture = await startHttpHandler({ sessionTtlMs: 1000 });
    const sessionId = await initialize(fixture.url);
    const first = callTool(fixture.url, sessionId, 2);
    await started[0].promise;
    const second = callTool(fixture.url, sessionId, 3);
    await started[1].promise;
    complete[0].resolve();
    await (await first).text();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.handler.activeSessionCount).toBe(1);
    expect(handle.close).not.toHaveBeenCalled();
    complete[1].resolve();
    await (await second).text();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.handler.activeSessionCount).toBe(0);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("still reaps an idle session with an open GET event stream", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fixture = await startHttpHandler({ sessionTtlMs: 1000 });
    const sessionId = await initialize(fixture.url);
    const stream = await fetch(fixture.url, {
      headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
    });
    expect(stream.status).toBe(200);

    await vi.advanceTimersByTimeAsync(60_000);
    await stream.text();
    expect(fixture.handler.activeSessionCount).toBe(0);
    expect(handles[0].close).toHaveBeenCalledTimes(1);
  });

  it("preserves the SDK close callback when reaping an idle session", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const handle = makeProxyHandle();
    const onclose = vi.fn();
    handle.server.server.onclose = onclose;
    vi.mocked(createServer).mockResolvedValueOnce(handle);
    const fixture = await startHttpHandler({ sessionTtlMs: 1000 });
    await initialize(fixture.url);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(fixture.handler.activeSessionCount).toBe(0);
  });

  it("releases the busy count after an existing transport request throws", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fixture = await startHttpHandler({ sessionTtlMs: 1000 });
    const sessionId = await initialize(fixture.url);
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest")
      .mockRejectedValueOnce(new Error("test request failure"));
    const response = await callTool(fixture.url, sessionId);
    await response.text();
    expect(response.status).toBe(500);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.handler.activeSessionCount).toBe(0);
    expect(handles[0].close).toHaveBeenCalledTimes(1);
    expect(fixture.errors).toHaveLength(1);
  });

  it.each(["transport", "proxy"] as const)(
    "logs a safe %s cleanup failure and still releases the reservation",
    async (stage) => {
      const handle = makeProxyHandle();
      const privateError = new Error("private-upstream-response-and-credential");
      vi.mocked(createServer).mockResolvedValueOnce(handle);
      if (stage === "transport") {
        vi.spyOn(StreamableHTTPServerTransport.prototype, "close")
          .mockRejectedValueOnce(privateError);
      } else {
        vi.mocked(handle.close).mockRejectedValueOnce(privateError);
      }
      const fixture = await startHttpHandler();
      const response = await fetch(fixture.url, {
        headers: { accept: "text/event-stream" },
      });
      await response.text();
      expect(response.status).toBe(400);
      await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1));
      const message = stage === "transport"
        ? "[session] transport close error:" : "[session] close error:";
      expect(console.error).toHaveBeenCalledWith(
        message, expect.stringContaining("[internal]"),
      );
      expect(vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n"))
        .not.toContain(privateError.message);
      await initialize(fixture.url);
      expect(fixture.handler.activeSessionCount).toBe(1);
    },
  );

  it("shares one bank configuration and token manager across distinct HTTP sessions", async () => {
    const baseConfig = makeFakeConfig();
    const config: Config = {
      ...baseConfig,
      apiHosts: { ...baseConfig.apiHosts, sandbox: "sandbox-api.example.test" },
      clientId: "shared-bank-client",
      sandbox: {
        certPath: "/unused/client.pem",
        keyPath: "/unused/client-key.pem",
        tokenUrl: "https://auth.example.test/token",
      },
    };
    const fixture = await startHttpHandler({ maxSessions: 2, proxyOptions: { config } });
    const firstSession = await initialize(fixture.url, "caller-a");
    const secondSession = await initialize(fixture.url, "caller-b");
    expect(firstSession).not.toBe(secondSession);
    expect(fixture.handler.activeSessionCount).toBe(2);

    const calls = vi.mocked(createServer).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]?.config).toBe(config);
    expect(calls[1][0]?.config).toBe(config);
    const shared = calls[0][0]?.tokenManager;
    if (!shared) throw new Error("Expected a handler-owned token manager");
    expect(shared).toBeInstanceOf(TokenManager);
    expect(calls[1][0]?.tokenManager).toBe(shared);

    const close = vi.spyOn(shared, "close");
    await Promise.all([fixture.handler.closeAll(), fixture.handler.closeAll()]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fixture.handler.activeSessionCount).toBe(0);
    expect(handles.every((handle) => vi.mocked(handle.close).mock.calls.length === 1)).toBe(true);
  });

  it("does not close a caller-owned token manager during HTTP shutdown", async () => {
    const tokenManager = new TokenManager({ config: makeFakeConfig() });
    const close = vi.spyOn(tokenManager, "close");
    try {
      const fixture = await startHttpHandler({ tokenManager });
      await initialize(fixture.url);
      expect(vi.mocked(createServer).mock.calls[0][0]?.tokenManager).toBe(tokenManager);
      await fixture.handler.closeAll();
      expect(close).not.toHaveBeenCalled();
    } finally {
      await tokenManager.close();
    }
  });

  it("closes a deleted session exactly once", async () => {
    const fixture = await startHttpHandler();
    const sessionId = await initialize(fixture.url);
    const response = await fetch(fixture.url, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    await response.text();
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(handles[0].close).toHaveBeenCalledTimes(1));
    expect(fixture.handler.activeSessionCount).toBe(0);
    await initialize(fixture.url);
    expect(fixture.handler.activeSessionCount).toBe(1);
  });

  it("waits for pending initialization during shutdown without creating a late session", async () => {
    const creating = gate();
    const handle = makeProxyHandle();
    vi.mocked(createServer).mockImplementationOnce(async () => {
      await creating.promise;
      return handle;
    });
    const fixture = await startHttpHandler();
    const request = startIncompleteRequest(fixture.url);
    await vi.waitFor(() => expect(fixture.arrivals).toHaveLength(1));
    let finished = false;
    const shutdown = fixture.handler.closeAll().then(() => {
      finished = true;
    });
    await setImmediate();
    expect(finished).toBe(false);
    creating.resolve();
    await shutdown;
    request.destroy();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(fixture.handler.activeSessionCount).toBe(0);
  });

  it("does not accept new sessions after shutdown", async () => {
    const fixture = await startHttpHandler();
    await fixture.handler.closeAll();
    const response = await fetch(fixture.url);
    await response.text();
    expect(response.status).toBe(503);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("closes each proxy only once across repeated shutdown calls", async () => {
    const fixture = await startHttpHandler();
    await initialize(fixture.url);
    await Promise.all([fixture.handler.closeAll(), fixture.handler.closeAll()]);
    expect(handles[0].close).toHaveBeenCalledTimes(1);
    expect(fixture.handler.activeSessionCount).toBe(0);
  });
});

describe("createLoopbackOriginCheck", () => {
  const isOk = createLoopbackOriginCheck({ port: 3001 });

  it("allows missing origin", () => {
    expect(isOk(undefined)).toBe(true);
  });

  it("allows loopback hosts on the configured port", () => {
    expect(isOk("http://127.0.0.1:3001")).toBe(true);
    expect(isOk("http://localhost:3001")).toBe(true);
    expect(isOk("http://[::1]:3001")).toBe(true);
  });

  it("rejects non-loopback hosts", () => {
    expect(isOk("http://example.com:3001")).toBe(false);
    expect(isOk("http://10.0.0.1:3001")).toBe(false);
  });

  it("rejects loopback on a different port", () => {
    expect(isOk("http://127.0.0.1:8080")).toBe(false);
    expect(isOk("http://localhost")).toBe(false);
  });

  it("rejects a malformed origin", () => {
    expect(isOk("not-a-url")).toBe(false);
    expect(isOk("")).toBe(true); // empty falsy → treated as missing
  });
});

describe("createLoopbackHostCheck", () => {
  const isOk = createLoopbackHostCheck({ port: 3001 });

  it("allows loopback host names on the configured port, in any letter case", () => {
    expect(isOk("127.0.0.1:3001")).toBe(true);
    expect(isOk("localhost:3001")).toBe(true);
    expect(isOk("LocalHost:3001")).toBe(true);
    expect(isOk("[::1]:3001")).toBe(true);
  });

  it("rejects a missing or empty Host header", () => {
    expect(isOk(undefined)).toBe(false);
    expect(isOk("")).toBe(false);
  });

  it.each([
    "evil.example:3001",
    "evil.example",
    "localhost.evil.example:3001",
    "127.0.0.1.evil.example:3001",
    "evil.example:3001, localhost:3001",
    "10.0.0.1:3001",
    "0.0.0.0:3001",
  ])("rejects a rebound or non-loopback host %j", (host) => {
    expect(isOk(host)).toBe(false);
  });

  it("rejects loopback on a different port, or without a port", () => {
    expect(isOk("127.0.0.1:8080")).toBe(false);
    expect(isOk("localhost")).toBe(false);
    expect(isOk("[::1]")).toBe(false);
  });

  it("accepts a bare loopback name only for port 80, where the Host header omits the port", () => {
    const onPort80 = createLoopbackHostCheck({ port: 80 });
    expect(onPort80("localhost")).toBe(true);
    expect(onPort80("127.0.0.1:80")).toBe(true);
    expect(onPort80("evil.example")).toBe(false);
    expect(createLoopbackHostCheck({ port: 8080 })("localhost")).toBe(false);
  });
});
