import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { Agent } from "undici";
import { TokenManager } from "../src/auth/token-manager.js";
import { ApicExecutor } from "../src/clients/apic-executor.js";
import type { Config } from "../src/config/config.js";

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("OAuth and API lifecycle over loopback HTTP", () => {
  let server: ReturnType<typeof createServer>;
  let dispatcher: Agent;
  let tokenManager: TokenManager;
  let executor: ApicExecutor;
  let origin: string;
  let now: number;
  let tokenForms: URLSearchParams[];
  let apiTokens: Array<string | undefined>;
  let invalidTokenReply: string | undefined;
  let replyToApi: (response: ServerResponse) => void;
  let requestErrors: Error[];

  beforeEach(async () => {
    now = 1_000_000;
    tokenForms = [];
    apiTokens = [];
    invalidTokenReply = undefined;
    requestErrors = [];
    replyToApi = (response) => sendJson(response, 200, { ok: true });
    server = createServer((request, response) => {
      if (request.url === "/token") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => { body += chunk; });
        request.on("error", (error: Error) => requestErrors.push(error));
        request.on("end", () => {
          tokenForms.push(new URLSearchParams(body));
          if (invalidTokenReply !== undefined) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(invalidTokenReply);
          } else {
            sendJson(response, 200, {
              access_token: `lifecycle-${tokenForms.length}`,
              token_type: "Bearer",
              expires_in: 120,
            });
          }
        });
      } else if (request.url === "/api") {
        apiTokens.push(request.headers.authorization);
        replyToApi(response);
      } else {
        response.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback TCP listener");
    }
    origin = `http://127.0.0.1:${address.port}`;
    const config: Config = {
      env: "test",
      mcpServerUrl: "https://catalog.example.test/mcp",
      apiHosts: { mock: "mock.example.test", sandbox: "sandbox.example.test" },
      tokenScope: "accounts",
      clientId: "lifecycle-client",
      sandbox: {
        certPath: "/unused/test-client.pem",
        keyPath: "/unused/test-client-key.pem",
        tokenUrl: `${origin}/token`,
      },
    };
    // A loopback dispatcher avoids real PEM files; this does not exercise TLS.
    dispatcher = new Agent();
    tokenManager = new TokenManager({
      config,
      agentFactory: () => dispatcher,
      now: () => now,
    });
    executor = new ApicExecutor({ tokenManager });
  });

  afterEach(async () => {
    server.closeAllConnections();
    try {
      await tokenManager.close();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
    expect(requestErrors).toEqual([]);
  });

  function callApi() {
    return executor.execute({ method: "GET", url: `${origin}/api`, tier: "sandbox" });
  }

  it("shares a cold token and refreshes once at the exact lead-window boundary", async () => {
    const coldCalls = await Promise.all(Array.from({ length: 8 }, () => callApi()));
    expect(coldCalls.every((response) => response.status === 200)).toBe(true);
    expect(tokenForms).toHaveLength(1);
    expect(Object.fromEntries(tokenForms[0])).toEqual({
      grant_type: "client_credentials",
      scope: "accounts",
      client_id: "lifecycle-client",
    });

    now += 59_999;
    await callApi();
    expect(tokenForms).toHaveLength(1);

    now += 1;
    await Promise.all(Array.from({ length: 4 }, () => callApi()));
    expect(tokenForms).toHaveLength(2);
    expect(apiTokens.slice(0, 9)).toEqual(Array(9).fill("Bearer lifecycle-1"));
    expect(apiTokens.slice(9)).toEqual(Array(4).fill("Bearer lifecycle-2"));
  });

  it("invalidates a rejected token and retries the API with a fresh token", async () => {
    replyToApi = (response) =>
      sendJson(response, apiTokens.length === 1 ? 401 : 200, { ok: apiTokens.length > 1 });

    const result = await callApi();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(tokenForms).toHaveLength(2);
    expect(apiTokens).toEqual(["Bearer lifecycle-1", "Bearer lifecycle-2"]);
  });

  it("returns a second 401 without an unbounded refresh or retry loop", async () => {
    replyToApi = (response) => sendJson(response, 401, { error: "denied" });

    const result = await callApi();
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "denied" });
    expect(tokenForms).toHaveLength(2);
    expect(apiTokens).toHaveLength(2);
  });

  it("rejects a malformed refresh without using the stale token and recovers on the next call", async () => {
    await callApi();
    now += 60_000;
    invalidTokenReply = "private-malformed-refresh-sentinel";
    const rejected = callApi();
    await expect(rejected).rejects.toThrow(/\[auth\] sandbox tier/);
    await expect(rejected).rejects.not.toThrow(invalidTokenReply);
    expect(tokenForms).toHaveLength(2);
    expect(apiTokens).toEqual(["Bearer lifecycle-1"]);

    invalidTokenReply = undefined;
    expect((await callApi()).status).toBe(200);
    expect(tokenForms).toHaveLength(3);
    expect(apiTokens).toEqual(["Bearer lifecycle-1", "Bearer lifecycle-3"]);
  });

  it("retains malformed API JSON as raw text after an authenticated wire call", async () => {
    replyToApi = (response) => {
      response.writeHead(200, { "content-type": "application/problem+json" });
      response.end('{"unfinished":');
    };

    const result = await callApi();
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"unfinished":');
    expect(tokenForms).toHaveLength(1);
  });

  it("cancels an oversized API response before its open stream finishes", async () => {
    const closedResponse = new Promise<ServerResponse>((resolve) => {
      replyToApi = (response) => {
        response.once("close", () => resolve(response));
        response.writeHead(200, { "content-length": String(10 * 1024 * 1024 + 1) });
        response.write("x");
      };
    });

    await expect(callApi()).rejects.toThrow(/Response body too large/);
    const response = await closedResponse;
    expect(response.destroyed).toBe(true);
    expect(response.writableFinished).toBe(false);
  });

  it("closes the shared token and API dispatcher after completed calls", async () => {
    await callApi();
    await tokenManager.close();
    await expect(dispatcher.request({ origin, path: "/api", method: "GET" }))
      .rejects.toMatchObject({ code: expect.stringMatching(/^UND_ERR_(?:CLOSED|DESTROYED)$/) });
  });
});
