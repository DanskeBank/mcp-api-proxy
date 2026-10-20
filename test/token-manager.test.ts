import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, type Dispatcher } from "undici";
import { TokenManager } from "../src/auth/token-manager.js";
import type { Config } from "../src/config/config.js";
import type { EnvironmentAuth, Tier } from "../src/types/index.js";

const FAKE_DISPATCHER = {
  async close() {},
} as unknown as Dispatcher;

function makeConfig(overrides: Partial<Config> = {}): Config {
  const sandbox: EnvironmentAuth = {
    certPath: "/tmp/sandbox.crt",
    keyPath: "/tmp/sandbox.key",
    tokenUrl: "https://example.test/sandbox/token",
  };
  return {
    env: "test",
    mcpServerUrl: "https://example.test/mcp",
    apiHosts: {
      mock: "test-mock-api.danskebank.com",
      live: "test-api.danskebank.com",
    },
    tokenScope: "accounts",
    clientId: "client-abc",
    sandbox,

    ...overrides,
  } as Config;
}

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TokenManager", () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and caches a token across calls within the refresh window", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "tok-1",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const tm = new TokenManager({
      config: makeConfig(),
      fetchImpl: fetchImpl as never,
      agentFactory: () => FAKE_DISPATCHER,
      now: () => now,
    });

    const a = await tm.getToken("sandbox");
    const b = await tm.getToken("sandbox");
    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("dedupes parallel requests via the in-flight map", async () => {
    let resolveResp: (r: Response) => void = () => {};
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((res) => {
          resolveResp = res;
        }),
    );
    const tm = new TokenManager({
      config: makeConfig(),
      fetchImpl: fetchImpl as never,
      agentFactory: () => FAKE_DISPATCHER,
      now: () => now,
    });

    const p1 = tm.getToken("sandbox");
    const p2 = tm.getToken("sandbox");
    resolveResp(
      tokenResponse({
        access_token: "tok-parallel",
        token_type: "Bearer",
        expires_in: 600,
      }),
    );
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe("tok-parallel");
    expect(b).toBe("tok-parallel");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token within the 60-second lead window", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse({
          access_token: "tok-old",
          token_type: "Bearer",
          expires_in: 100, // lead = min(60_000, floor(100_000/2)) = 50_000; refreshAt = now + 50_000
        }),
      )
      .mockResolvedValueOnce(
        tokenResponse({
          access_token: "tok-new",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    const tm = new TokenManager({
      config: makeConfig(),
      fetchImpl: fetchImpl as never,
      agentFactory: () => FAKE_DISPATCHER,
      now: () => now,
    });

    expect(await tm.getToken("sandbox")).toBe("tok-old");
    now += 49_999; // still in cache window
    expect(await tm.getToken("sandbox")).toBe("tok-old");
    now += 2; // crossed refreshAt
    expect(await tm.getToken("sandbox")).toBe("tok-new");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces a fresh fetch on the next call", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse({
          access_token: "tok-1",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        tokenResponse({
          access_token: "tok-2",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    const tm = new TokenManager({
      config: makeConfig(),
      fetchImpl: fetchImpl as never,
      agentFactory: () => FAKE_DISPATCHER,
      now: () => now,
    });

    expect(await tm.getToken("sandbox")).toBe("tok-1");
    tm.invalidate("sandbox");
    expect(await tm.getToken("sandbox")).toBe("tok-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports the tier and status without the token endpoint body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("private-token-sentinel-8675309", {
        status: 401,
        headers: { "content-type": "text/plain" },
      }),
    );
    const tm = new TokenManager({
      config: makeConfig(),
      fetchImpl: fetchImpl as never,
      agentFactory: () => FAKE_DISPATCHER,
      now: () => now,
    });
    const token = tm.getToken("sandbox");
    await expect(token).rejects.toThrow(/sandbox tier.*401/);
    await expect(token).rejects.not.toThrow("private-token-sentinel-8675309");
  });

  it("cancels a rejected token response without reading its body", async () => {
    const response = new Response("private-token-sentinel-8675309", { status: 401 });
    const cancel = vi.spyOn(response.body!, "cancel");
    const readText = vi.spyOn(response, "text");
    const tm = new TokenManager({
      config: makeConfig(),
      fetchImpl: vi.fn().mockResolvedValue(response) as never,
      agentFactory: () => FAKE_DISPATCHER,
    });

    await expect(tm.getToken("sandbox")).rejects.toThrow(/401/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(readText).not.toHaveBeenCalled();
  });

  it("does not expose a non-JSON token response or its parser error", async () => {
    const tm = new TokenManager({
      config: makeConfig(),
      fetchImpl: vi.fn().mockResolvedValue(new Response("private-json-sentinel-8675309")) as never,
      agentFactory: () => FAKE_DISPATCHER,
    });

    const token = tm.getToken("sandbox");
    await expect(token).rejects.not.toThrow("private-json-sentinel-8675309");
    await expect(token).rejects.toThrow(/\[auth\].*sandbox tier/);
  });

  it("throws when no credentials are configured for the requested tier", async () => {
    const tm = new TokenManager({
      config: makeConfig({ live: undefined }),
      fetchImpl: vi.fn() as never,
      agentFactory: () => FAKE_DISPATCHER,
      now: () => now,
    });
    await expect(tm.getToken("live")).rejects.toThrow(/live tier/i);
  });

  it("caches one dispatcher per tier", () => {
    const factory = vi.fn(() => FAKE_DISPATCHER);
    const tm = new TokenManager({
      config: makeConfig({
        live: {
          certPath: "/tmp/p.crt",
          keyPath: "/tmp/p.key",
          tokenUrl: "https://example.test/live/token",
        },
      }),
      fetchImpl: vi.fn() as never,
      agentFactory: factory,
      now: () => now,
    });
    tm.getDispatcher("sandbox");
    tm.getDispatcher("sandbox");
    tm.getDispatcher("live");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("passes config.extraCaCertPath through to the agent factory", () => {
    const factory = vi.fn(() => FAKE_DISPATCHER);
    const tm = new TokenManager({
      config: makeConfig({ extraCaCertPath: "/tmp/internal-ca.pem" }),
      fetchImpl: vi.fn() as never,
      agentFactory: factory,
      now: () => now,
    });
    tm.getDispatcher("sandbox");
    expect(factory).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/internal-ca.pem",
    );
  });

  it("passes undefined extraCaCertPath through when unset (e.g. prod)", () => {
    const factory = vi.fn(() => FAKE_DISPATCHER);
    const tm = new TokenManager({
      config: makeConfig(),
      fetchImpl: vi.fn() as never,
      agentFactory: factory,
      now: () => now,
    });
    tm.getDispatcher("sandbox");
    expect(factory).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it("sends the correct form-encoded request body to the token endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const tm = new TokenManager({
      config: makeConfig(),
      fetchImpl: fetchImpl as never,
      agentFactory: () => FAKE_DISPATCHER,
      now: () => now,
    });
    await tm.getToken("sandbox");
    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      { method: string; body: string; headers: Record<string, string> },
    ];
    expect(url).toBe("https://example.test/sandbox/token");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(init.body);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("scope")).toBe("accounts");
    expect(params.get("client_id")).toBe("client-abc");
  });

  it("does not follow a redirect from the token endpoint", async () => {
    let redirectTargetHits = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/token") {
        res.writeHead(307, { location: "/elsewhere" }).end("private-redirect-body-123");
        return;
      }
      redirectTargetHits += 1;
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ access_token: "stolen", expires_in: 3600 }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const tm = new TokenManager({
      config: makeConfig({
        sandbox: {
          certPath: "/tmp/sandbox.crt",
          keyPath: "/tmp/sandbox.key",
          tokenUrl: `http://127.0.0.1:${port}/token`,
        },
      }),
      agentFactory: () => new Agent(),
      now: () => now,
    });

    try {
      const token = tm.getToken("sandbox");
      await expect(token).rejects.toThrow(/\[auth\] sandbox tier \(HTTP 307\)/);
      await expect(token).rejects.not.toThrow("private-redirect-body-123");
      expect(redirectTargetHits).toBe(0);
    } finally {
      await tm.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("OAuth token response validation", () => {
  const sentinel = "private-token-response-123";
  const valid = {
    access_token: "valid-token",
    expires_in: 3600,
    token_type: "Bearer",
  };

  function setup(fetchImpl: ReturnType<typeof vi.fn>, now?: () => number) {
    return new TokenManager({
      config: makeConfig({
        clientId: sentinel,
        live: {
          certPath: "/tmp/live.crt",
          keyPath: "/tmp/live.key",
          tokenUrl: "https://example.test/live/token",
        },
      }),
      fetchImpl: fetchImpl as never,
      agentFactory: () => FAKE_DISPATCHER,
      now,
    });
  }

  async function expectRejectedWithoutCaching(
    response: unknown,
    invalidFields: string[],
    tier: Exclude<Tier, "mock"> = "sandbox",
  ) {
    // A mock JSON decoder also exercises non-finite JS numbers, which JSON.stringify would turn into null.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => response })
      .mockResolvedValueOnce(tokenResponse(valid));
    const tm = setup(fetchImpl);
    try {
      const token = tm.getToken(tier);
      await expect(token).rejects.toThrow(`[auth] ${tier} tier`);
      for (const field of invalidFields) {
        await expect(token).rejects.toThrow(field);
      }
      await expect(token).rejects.not.toThrow(sentinel);
      await expect(tm.getToken(tier)).resolves.toBe(valid.access_token);
      await expect(tm.getToken(tier)).resolves.toBe(valid.access_token);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await tm.close();
    }
  }

  it.each([
    ["missing", undefined],
    ["null", null],
    ["object", { private: sentinel }],
    ["array", [sentinel]],
    ["number", 42],
    ["boolean", true],
    ["empty", ""],
    ["spaces", "   "],
    ["whitespace", "\t\n\r"],
  ])("rejects a %s access_token without caching or leaking values", async (_label, access_token) => {
    await expectRejectedWithoutCaching({ ...valid, access_token }, ["access_token"]);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["zero", 0],
    ["negative", -1],
    ["NaN", NaN],
    ["infinity", Infinity],
    ["negative infinity", -Infinity],
    ["numeric string", "3600"],
    ["private string", sentinel],
    ["object", { private: sentinel }],
    ["boolean", true],
  ])("rejects %s expires_in without caching or leaking values", async (_label, expires_in) => {
    await expectRejectedWithoutCaching({ ...valid, access_token: sentinel, expires_in }, ["expires_in"]);
  });

  it.each([
    ["non-Bearer", sentinel],
    ["empty", ""],
    ["whitespace", " "],
    ["null", null],
    ["number", 42],
    ["object", { private: sentinel }],
    ["array", ["Bearer"]],
  ])("rejects a %s token_type without caching or leaking values", async (_label, token_type) => {
    await expectRejectedWithoutCaching({ ...valid, access_token: sentinel, token_type }, ["token_type"]);
  });

  it.each([
    ["null", null],
    ["array", [sentinel]],
    ["string", sentinel],
    ["number", 42],
    ["boolean", true],
  ])("rejects a %s JSON root with safe response guidance", async (_label, response) => {
    await expectRejectedWithoutCaching(response, ["response"]);
  });

  it("reports all invalid field names for the live tier without their values", async () => {
    await expectRejectedWithoutCaching({
      access_token: { private: sentinel },
      expires_in: sentinel,
      token_type: sentinel,
      [sentinel]: sentinel,
    }, ["access_token", "expires_in", "token_type"], "live");
  });

  it("reports missing token and lifetime fields without echoing unknown field names", async () => {
    await expectRejectedWithoutCaching({ [sentinel]: sentinel }, ["access_token", "expires_in"]);
  });

  it.each([undefined, "Bearer", "bearer", "BEARER", "bEaReR"])(
    "accepts token_type %j without rewriting the token",
    async (token_type) => {
      const access_token = "opaque.+/token==";
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        tokenResponse({ ...valid, access_token, token_type }),
      );
      const tm = setup(fetchImpl);
      try {
        await expect(tm.getToken("sandbox")).resolves.toBe(access_token);
        await expect(tm.getToken("sandbox")).resolves.toBe(access_token);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } finally {
        await tm.close();
      }
    },
  );

  it.each(["<html>private-token-response-123</html>", "{\"access_token\":", ""])(
    "rejects a malformed JSON body and recovers on the next call (%#)",
    async (body) => {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response(body))
        .mockResolvedValueOnce(tokenResponse(valid));
      const tm = setup(fetchImpl);
      try {
        const token = tm.getToken("sandbox");
        await expect(token).rejects.toThrow(/\[auth\].*sandbox tier.*JSON/);
        await expect(token).rejects.not.toThrow(sentinel);
        await expect(tm.getToken("sandbox")).resolves.toBe(valid.access_token);
        await expect(tm.getToken("sandbox")).resolves.toBe(valid.access_token);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        await tm.close();
      }
    },
  );

  it("does not cache a lifetime that overflows the refresh timestamp", async () => {
    await expectRejectedWithoutCaching({ ...valid, expires_in: Number.MAX_VALUE }, ["expires_in"]);
  });

  it.each([
    [3600, 3_540_000],
    [2, 1_000],
    [0.5, 250],
  ])("refreshes expires_in=%s at the exact refresh boundary", async (expires_in, refreshAfter) => {
    let now = 1_000_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ ...valid, access_token: "old-token", expires_in }))
      .mockResolvedValueOnce(tokenResponse({ ...valid, access_token: "new-token" }));
    const tm = setup(fetchImpl, () => now);
    try {
      await expect(tm.getToken("sandbox")).resolves.toBe("old-token");
      now += refreshAfter - 1;
      await expect(tm.getToken("sandbox")).resolves.toBe("old-token");
      now += 1;
      await expect(tm.getToken("sandbox")).resolves.toBe("new-token");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await tm.close();
    }
  });

  it("refreshes an expired token after a clock jump", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ ...valid, access_token: "expired-token", expires_in: 1 }))
      .mockResolvedValueOnce(tokenResponse(valid));
    const tm = setup(fetchImpl, () => now);
    try {
      await expect(tm.getToken("sandbox")).resolves.toBe("expired-token");
      now += 1_001;
      await expect(tm.getToken("sandbox")).resolves.toBe(valid.access_token);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await tm.close();
    }
  });

  it("does not cache a malformed refresh response or reuse the stale token", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ ...valid, access_token: "stale-token", expires_in: 2 }))
      .mockResolvedValueOnce(tokenResponse({ ...valid, access_token: { private: sentinel } }))
      .mockResolvedValueOnce(tokenResponse(valid));
    const tm = setup(fetchImpl, () => now);
    try {
      await expect(tm.getToken("sandbox")).resolves.toBe("stale-token");
      now += 1_000;
      await expect(tm.getToken("sandbox")).rejects.toThrow("access_token");
      await expect(tm.getToken("sandbox")).resolves.toBe(valid.access_token);
      await expect(tm.getToken("sandbox")).resolves.toBe(valid.access_token);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      await tm.close();
    }
  });

  it("shares a rejected in-flight request and retries after the rejection", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ ...valid, access_token: { private: sentinel } }))
      .mockResolvedValueOnce(tokenResponse(valid));
    const tm = setup(fetchImpl);
    try {
      const outcomes = await Promise.allSettled([tm.getToken("sandbox"), tm.getToken("sandbox")]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await expect(tm.getToken("sandbox")).resolves.toBe(valid.access_token);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await tm.close();
    }
  });

  it("keeps token caches isolated between tiers", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ ...valid, access_token: "sandbox-token" }))
      .mockResolvedValueOnce(tokenResponse({ ...valid, access_token: "live-token" }));
    const tm = setup(fetchImpl);
    try {
      await expect(tm.getToken("sandbox")).resolves.toBe("sandbox-token");
      await expect(tm.getToken("live")).resolves.toBe("live-token");
      await expect(tm.getToken("sandbox")).resolves.toBe("sandbox-token");
      await expect(tm.getToken("live")).resolves.toBe("live-token");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await tm.close();
    }
  });

  it("continues using TOKEN_SCOPE when the granted scope differs", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn().mockImplementation(async () => tokenResponse({
      ...valid,
      expires_in: 2,
      scope: "different-granted-scope",
    }));
    const tm = setup(fetchImpl, () => now);
    try {
      await expect(tm.getToken("sandbox")).resolves.toBe(valid.access_token);
      now += 1_000;
      await expect(tm.getToken("sandbox")).resolves.toBe(valid.access_token);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchImpl.mock.calls) {
        expect(new URLSearchParams(init.body).get("scope")).toBe("accounts");
      }
    } finally {
      await tm.close();
    }
  });
});
