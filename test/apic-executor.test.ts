import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import {
  ApicExecutor,
  type AuthFetchInit,
} from "../src/clients/apic-executor.js";
import { TokenManager } from "../src/auth/token-manager.js";
import type { Config } from "../src/config/config.js";

function makeConfig(): Config {
  return {
    env: "test",
    mcpServerUrl: "https://example.test/mcp",
    apiHosts: {
      mock: "test-mock-api.danskebank.com",
      live: "test-api.danskebank.com",
    },
    tokenScope: "accounts",
    clientId: "client-abc",
    sandbox: {
      certPath: "/tmp/sandbox.crt",
      keyPath: "/tmp/sandbox.key",
      tokenUrl: "https://example.test/sandbox/token",
    },
  } as Config;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ApicExecutor (auth path)", () => {
  it("attaches Bearer token from TokenManager and uses tier dispatcher seam", async () => {
    const tokenManager = new TokenManager({
      config: makeConfig(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          access_token: "abc.tok",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      ) as any,
      agentFactory: () => ({ async close() {} }) as never,
    });

    const calls: Array<{ tier: string; url: string; init: AuthFetchInit }> = [];
    const authFetch = vi.fn(async (tier, url, init: AuthFetchInit) => {
      calls.push({ tier, url, init });
      return jsonResponse({ ok: true });
    });

    const executor = new ApicExecutor({ tokenManager, authFetch });

    const res = await executor.execute({
      method: "GET",
      url: "https://test-sandbox-api.danskebank.com/accounts/v5/accounts",
      tier: "sandbox",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(calls[0].tier).toBe("sandbox");
    expect(calls[0].init.headers.authorization).toBe("Bearer abc.tok");
  });

  it("retries once on 401 after invalidating the token", async () => {
    let tokenCallCount = 0;
    const fetchImpl = vi.fn(async () => {
      tokenCallCount += 1;
      return jsonResponse({
        access_token: `tok-${tokenCallCount}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    });

    const tokenManager = new TokenManager({
      config: makeConfig(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
      agentFactory: () => ({ async close() {} }) as never,
    });

    const responses = [
      new Response("expired", { status: 401 }),
      jsonResponse({ ok: true }),
    ];
    const authFetch = vi.fn(async () => responses.shift()!);

    const executor = new ApicExecutor({ tokenManager, authFetch });
    const res = await executor.execute({
      method: "GET",
      url: "https://test-sandbox-api.danskebank.com/x",
      tier: "sandbox",
    });

    expect(res.status).toBe(200);
    expect(authFetch).toHaveBeenCalledTimes(2);
    // First call used tok-1, retry forced a fresh fetch and used tok-2.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not call TokenManager for mock tier", async () => {
    const fetchImpl = vi.fn();
    const tokenManager = new TokenManager({
      config: makeConfig(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
      agentFactory: () => ({ async close() {} }) as never,
    });
    const getTokenSpy = vi.spyOn(tokenManager, "getToken");

    // Stub global fetch for the mock-tier path.
    const globalFetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ mock: true }));

    const executor = new ApicExecutor({ tokenManager });
    const res = await executor.execute({
      method: "GET",
      url: "https://test-mock-api.danskebank.com/anything",
      tier: "mock",
    });

    expect(res.status).toBe(200);
    expect(getTokenSpy).not.toHaveBeenCalled();
    expect(globalFetchSpy).toHaveBeenCalledTimes(1);
    globalFetchSpy.mockRestore();
  });

  it("throws when an authenticated tier is requested without a TokenManager", async () => {
    const executor = new ApicExecutor();
    await expect(
      executor.execute({
        method: "GET",
        url: "https://test-sandbox-api.danskebank.com/x",
        tier: "sandbox",
      }),
    ).rejects.toThrow(/without a TokenManager/);
  });

  it("returns a redirect as is instead of following it with the bearer token", async () => {
    const targetAuthHeaders: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/target" }).end();
        return;
      }
      targetAuthHeaders.push(req.headers.authorization);
      res.writeHead(200).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const tokenManager = new TokenManager({
      config: makeConfig(),
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          access_token: "abc.tok",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      ) as never,
      agentFactory: () => new Agent(),
    });

    try {
      const res = await new ApicExecutor({ tokenManager }).execute({
        method: "GET",
        url: `http://127.0.0.1:${port}/start`,
        tier: "sandbox",
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/target");
      expect(targetAuthHeaders).toEqual([]);
    } finally {
      await tokenManager.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("ApicExecutor response handling", () => {
  const maxBytes = 10 * 1024 * 1024;

  afterEach(() => vi.restoreAllMocks());

  async function executeResponse(response: Response) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    return new ApicExecutor().execute({
      method: "GET",
      url: "https://mock-api.example.test/response",
      tier: "mock",
    });
  }

  it.each([
    "application/json",
    "application/problem+json",
    "application/vnd.api+json",
    "application/hal+json; charset=utf-8",
    "Application/Problem+JSON; Charset=UTF-8",
    " application/json ; charset=utf-8 ",
  ])("parses %s as JSON and preserves status and headers", async (contentType) => {
    const result = await executeResponse(new Response('{"detail":"example"}', {
      status: 422,
      headers: { "content-type": contentType, "x-example": "preserved" },
    }));

    expect(result.status).toBe(422);
    expect(result.headers["x-example"]).toBe("preserved");
    expect(result.body).toEqual({ detail: "example" });
  });

  it.each(["application/json", "application/problem+json", "application/vnd.api+json"])(
    "keeps malformed %s as raw text",
    async (contentType) => {
      const result = await executeResponse(new Response('{"unfinished":', {
        headers: { "content-type": contentType },
      }));

      expect(result.body).toBe('{"unfinished":');
    },
  );

  it.each(["application/json", "application/problem+json"])(
    "returns null for an empty %s response",
    async (contentType) => {
      const result = await executeResponse(new Response(null, {
        status: 204,
        headers: { "content-type": contentType },
      }));

      expect(result.body).toBeNull();
    },
  );

  it.each([
    "text/plain",
    "text/problem+json",
    "text/application/json",
    "application/json-seq",
    "application/jsonp",
    "application/vnd.example+json-extra",
  ])("keeps non-JSON media type %s as text", async (contentType) => {
    const result = await executeResponse(new Response('{"example":true}', {
      headers: { "content-type": contentType },
    }));

    expect(result.body).toBe('{"example":true}');
  });

  it("cancels a body rejected by Content-Length without reading it", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const getReader = vi.spyOn(stream, "getReader");

    await expect(executeResponse(new Response(stream, {
      headers: { "content-length": String(maxBytes + 1) },
    }))).rejects.toThrow(`${maxBytes + 1} bytes exceeds ${maxBytes}-byte limit`);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
  });

  it.each(["declared", "streamed"] as const)(
    "retains the %s size error and reports a cancellation failure without exposing it",
    async (source) => {
      const sentinel = "private-cancellation-error-8675309";
      const cancel = vi.fn().mockRejectedValue(new Error(sentinel));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (source === "streamed") controller.enqueue(new Uint8Array(maxBytes + 1));
        },
        cancel,
      });

      await expect(executeResponse(new Response(stream, {
        headers: source === "declared" ? { "content-length": String(maxBytes + 1) } : {},
      }))).rejects.toThrow(`${maxBytes}-byte limit`);

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("[proxy] Could not cancel an oversized API response body.");
      expect(log.mock.calls.flat().join(" ")).not.toContain(sentinel);
    },
  );

  it("rejects an oversized declared length even when there is no body", async () => {
    await expect(executeResponse(new Response(null, {
      headers: { "content-length": String(maxBytes + 1) },
    }))).rejects.toThrow(`${maxBytes}-byte limit`);
  });

  it.each([false, true])("accepts exactly 10 MiB with a declared length: %s", async (declared) => {
    const text = "a".repeat(maxBytes);
    const result = await executeResponse(new Response(text, {
      headers: {
        "content-type": "text/plain",
        ...(declared ? { "content-length": String(maxBytes) } : {}),
      },
    }));

    expect(result.body).toBe(text);
  });

  it.each([false, true])("cancels an oversized stream with a misleading length: %s", async (declared) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(maxBytes));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });

    await expect(executeResponse(new Response(stream, {
      headers: declared ? { "content-length": String(maxBytes) } : {},
    }))).rejects.toThrow(`exceeded ${maxBytes}-byte limit`);

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
