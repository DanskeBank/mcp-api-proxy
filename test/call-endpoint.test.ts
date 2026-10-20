import { describe, expect, it, vi } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  buildCallEndpointToolDefinition,
  callEndpointToolDefinition,
  getToolDescription,
  handleCallEndpoint,
  type CallEndpointDeps,
} from "../src/tools/call-endpoint.js";
import type { Config } from "../src/config/config.js";
import { ApicExecutor } from "../src/clients/apic-executor.js";
import { TokenManager } from "../src/auth/token-manager.js";
import { ProxyError } from "../src/errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiResponse, EnvironmentAuth } from "../src/types/index.js";

const AUTH: EnvironmentAuth = {
  certPath: "/tmp/client.crt",
  keyPath: "/tmp/client.key",
  tokenUrl: "https://test-api.danskebank.com/token",
};

const ALL_HOSTS = {
  mock: "test-mock-api.danskebank.com",
  sandbox: "test-sandbox-api.danskebank.com",
  live: "test-api.danskebank.com",
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: "test",
    mcpServerUrl: "https://test-mcp.danskebank.com/mcp",
    apiHosts: {
      mock: "test-mock-api.danskebank.com",
      live: "test-api.danskebank.com",
    },
    tokenScope: "accounts",

    ...overrides,
  };
}

function makeExecutor(response: ApiResponse): ApicExecutor {
  return {
    execute: vi.fn().mockResolvedValue(response),
  } as unknown as ApicExecutor;
}

function makeDeps(overrides: Partial<CallEndpointDeps> = {}): CallEndpointDeps {
  return {
    config: makeConfig(),
    apicExecutor: makeExecutor({ status: 200, headers: {}, body: {} }),
    ...overrides,
  };
}

const fakeAuth = {
  certPath: "/tmp/example.crt",
  keyPath: "/tmp/example.key",
  tokenUrl: "https://auth.example.test/token",
};

function resultPayload(result: CallToolResult): unknown {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected a text result");
  return JSON.parse(content.text);
}

function expectStructuredResult(result: CallToolResult): void {
  expect(result.structuredContent).toEqual(resultPayload(result));
  const { outputSchema } = buildCallEndpointToolDefinition(makeConfig());
  expect(outputSchema.type).toBe("object");
  const validate = new AjvJsonSchemaValidator().getValidator(outputSchema);
  expect(validate(result.structuredContent)).toMatchObject({ valid: true });
}

describe("handleCallEndpoint", () => {
  it("rejects invalid arguments", async () => {
    const result = await handleCallEndpoint({}, makeDeps());
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Invalid arguments");
  });

  describe("call_endpoint result semantics", () => {
    it.each([
      { status: 200, category: undefined, retryable: undefined },
      { status: 204, category: undefined, retryable: undefined },
      { status: 302, category: undefined, retryable: undefined },
      { status: 399, category: undefined, retryable: undefined },
      { status: 400, category: "validation", retryable: false },
      { status: 401, category: "auth", retryable: false },
      { status: 403, category: "auth", retryable: false },
      { status: 404, category: "not_found", retryable: false },
      { status: 408, category: "upstream", retryable: true },
      { status: 409, category: "validation", retryable: false },
      { status: 422, category: "validation", retryable: false },
      { status: 429, category: "rate_limited", retryable: true },
      { status: 500, category: "upstream", retryable: true },
      { status: 501, category: "upstream", retryable: false },
      { status: 502, category: "upstream", retryable: true },
      { status: 503, category: "upstream", retryable: true },
      { status: 504, category: "upstream", retryable: true },
      { status: 505, category: "upstream", retryable: false },
    ])("reports HTTP $status without hiding the API response", async ({ status, category, retryable }) => {
      const response: ApiResponse = {
        status,
        headers: { "x-request-id": "response-marker", "retry-after": "10" },
        body: { detail: "original-api-payload" },
      };
      const result = await handleCallEndpoint(
        { method: "GET", url: "/accounts", tier: "mock" },
        makeDeps({ apicExecutor: makeExecutor(response) }),
      );

      expect(result.isError).toBe(status >= 400 ? true : undefined);
      expect(result._meta?.statusCode).toBe(status);
      expectStructuredResult(result);
      expect(resultPayload(result)).toMatchObject({ tier: "mock", ...response });
      if (category) {
        expect(resultPayload(result)).toMatchObject({
          error: { category, retryable, nextStep: expect.any(String) },
        });
        expect(result._meta?.errorCategory).toBe(category);
        expect(resultPayload(result)).toMatchObject({
          error: { nextStep: expect.stringMatching(/\S/) },
        });
      } else {
        expect(resultPayload(result)).not.toHaveProperty("error");
      }
    });

    it.each([
      { tier: "mock", auth: {} },
      { tier: "sandbox", auth: { sandbox: fakeAuth } },
      { tier: "live", auth: { sandbox: fakeAuth, live: fakeAuth } },
    ] as const)("includes the actual $tier tier for a defaulted path request", async ({ tier, auth }) => {
      const result = await handleCallEndpoint(
        { method: "GET", url: "/accounts" },
        makeDeps({ config: makeConfig({ apiHosts: ALL_HOSTS, ...auth }) }),
      );
      expectStructuredResult(result);
      expect(resultPayload(result)).toMatchObject({ tier, status: 200 });
    });

    it.each(["POST", "PUT", "PATCH", "DELETE"])(
      "does not encourage replaying a failed %s request",
      async (method) => {
        for (const status of [408, 429, 500, 503]) {
          const result = await handleCallEndpoint(
            { method, url: "/accounts", tier: "mock" },
            makeDeps({ apicExecutor: makeExecutor({ status, headers: {}, body: "failure" }) }),
          );
          expect(result.isError).toBe(true);
          expect(resultPayload(result)).toMatchObject({
            error: {
              retryable: false,
              nextStep: expect.stringContaining("Do not automatically replay"),
            },
          });
        }
      },
    );

    it.each(
      [null, "", "text response", ["first", "second"], 0, false, { nested: [null, true] }]
        .map((body) => ({ body })),
    )(
      "retains the original response representation (%#)",
      async ({ body }) => {
        const result = await handleCallEndpoint(
          { method: "GET", url: "/accounts", tier: "mock" },
          makeDeps({ apicExecutor: makeExecutor({ status: 500, headers: {}, body }) }),
        );
        expectStructuredResult(result);
        expect(resultPayload(result)).toMatchObject({ body });
      },
    );

    it("gives safe validation guidance without inventing a destination", async () => {
      const result = await handleCallEndpoint({}, makeDeps());
      expectStructuredResult(result);
      expect(resultPayload(result)).toMatchObject({
        error: {
          category: "validation",
          retryable: false,
          message: expect.stringContaining("Invalid arguments"),
          nextStep: expect.stringContaining("schema"),
        },
      });
      expect(resultPayload(result)).not.toHaveProperty("tier");
      expect(result._meta?.errorCategory).toBe("validation");
    });

    it("reports missing tier credentials as configuration, not an API response", async () => {
      const result = await handleCallEndpoint(
        { method: "GET", url: "https://test-api.danskebank.com/accounts" },
        makeDeps(),
      );
      expectStructuredResult(result);
      expect(resultPayload(result)).toMatchObject({
        tier: "live",
        error: {
          category: "configuration",
          retryable: false,
          nextStep: expect.stringContaining("settings"),
        },
      });
      expect(resultPayload(result)).not.toHaveProperty("status");
    });

    it.each([
      { category: "auth", error: new ProxyError("auth", { tier: "mock", statusCode: 401 }), retryable: false },
      { category: "configuration", error: new ProxyError("configuration"), retryable: false },
      { category: "internal", error: new ProxyError("internal"), retryable: false },
      { category: "validation", error: new ProxyError("validation"), retryable: false },
      { category: "not_found", error: new ProxyError("not_found"), retryable: false },
      { category: "rate_limited", error: new ProxyError("rate_limited"), retryable: true },
      { category: "upstream", error: new Error("private-network-error"), retryable: true },
    ] as const)("reports a safe $category execution failure with a next step", async ({ category, error, retryable }) => {
      const executor = makeExecutor({ status: 200, headers: {}, body: null });
      vi.mocked(executor.execute).mockRejectedValueOnce(error);
      const result = await handleCallEndpoint(
        { method: "GET", url: "/accounts", tier: "mock" },
        makeDeps({ apicExecutor: executor }),
      );
      expect(result.isError).toBe(true);
      expectStructuredResult(result);
      expect(resultPayload(result)).toMatchObject({
        tier: "mock",
        error: { category, retryable, nextStep: expect.any(String) },
      });
      expect(resultPayload(result)).not.toHaveProperty("status");
      expect(JSON.stringify(result)).not.toContain("private-network-error");
    });

    it("does not suggest retrying a failed non-GET transport operation", async () => {
      const executor = makeExecutor({ status: 200, headers: {}, body: null });
      vi.mocked(executor.execute).mockRejectedValueOnce(new Error("private-network-error"));
      const result = await handleCallEndpoint(
        { method: "POST", url: "/accounts", tier: "mock" },
        makeDeps({ apicExecutor: executor }),
      );
      expect(resultPayload(result)).toMatchObject({
        error: { category: "upstream", retryable: false,
          nextStep: expect.stringContaining("Do not automatically replay") },
      });
    });

    it("keeps auth and rate-limit recovery actionable", async () => {
      for (const [status, hint] of [[401, "credentials"], [403, "scope"], [404, "get_endpoint_details"], [429, "Retry-After"]] as const) {
        const result = await handleCallEndpoint(
          { method: "GET", url: "/accounts", tier: "mock" },
          makeDeps({ apicExecutor: makeExecutor({ status, headers: {}, body: null }) }),
        );
        expect(resultPayload(result)).toMatchObject({
          error: { nextStep: expect.stringContaining(hint) },
        });
      }
    });
  });

  it("rejects a body on GET requests", async () => {
    const result = await handleCallEndpoint(
      {
        method: "GET",
        url: "https://test-mock-api.danskebank.com/foo",
        body: { hello: "world" },
      },
      makeDeps(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "Request body is not allowed for GET",
    );
  });

  it("rejects a body on DELETE requests", async () => {
    const result = await handleCallEndpoint(
      {
        method: "DELETE",
        url: "https://test-mock-api.danskebank.com/foo",
        body: { hello: "world" },
      },
      makeDeps(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "Request body is not allowed for DELETE",
    );
  });

  it("rejects malformed URLs", async () => {
    const result = await handleCallEndpoint(
      { method: "GET", url: "not-a-url" },
      makeDeps(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Invalid URL");
  });

  it("rejects URLs that are not in the allow-list", async () => {
    const result = await handleCallEndpoint(
      { method: "GET", url: "https://evil.example.com/foo" },
      makeDeps(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("URL not allowed");
  });

  it("rejects non-GET methods against live", async () => {
    const result = await handleCallEndpoint(
      {
        method: "POST",
        url: "https://test-api.danskebank.com/foo",
      },
      makeDeps({ config: makeConfig({ live: undefined }) }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Live is read-only");
  });

  it("rejects live GET when live credentials are missing", async () => {
    const result = await handleCallEndpoint(
      { method: "GET", url: "https://test-api.danskebank.com/foo" },
      makeDeps(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("CLIENT_CERT_PEM");
  });

  it("rejects sandbox call when host is not in allow-list (no sandbox tier in test env)", async () => {
    const result = await handleCallEndpoint(
      { method: "GET", url: "https://test-sandbox-api.danskebank.com/foo" },
      makeDeps(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("URL not allowed");
  });

  it("rejects sandbox call when sandbox credentials are missing (prod env)", async () => {
    const cfg = makeConfig({
      apiHosts: {
        mock: "mock-api.danskebank.com",
        sandbox: "sandbox-api.danskebank.com",
        live: "api.danskebank.com",
      },
    });
    const result = await handleCallEndpoint(
      { method: "GET", url: "https://sandbox-api.danskebank.com/foo" },
      makeDeps({ config: cfg }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("CLIENT_CERT_PEM");
  });

  it("executes mock calls without auth and surfaces the upstream status via _meta", async () => {
    const executor = makeExecutor({
      status: 201,
      headers: { "x-test": "1" },
      body: { ok: true },
    });
    const result = await handleCallEndpoint(
      {
        method: "POST",
        url: "https://test-mock-api.danskebank.com/foo",
        body: { hello: "world" },
      },
      makeDeps({ apicExecutor: executor }),
    );

    expect(result.isError).toBeUndefined();
    expect(result._meta).toEqual({ statusCode: 201 });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "https://test-mock-api.danskebank.com/foo",
        tier: "mock",
      }),
    );
  });

  it("returns an error result when the executor throws", async () => {
    const executor = {
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as ApicExecutor;
    const result = await handleCallEndpoint(
      { method: "GET", url: "https://test-mock-api.danskebank.com/foo" },
      makeDeps({ apicExecutor: executor }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("[upstream]");
    expect(JSON.stringify(result.content)).not.toContain("boom");
  });

  it.each([
    { tier: "mock", auth: {} },
    { tier: "sandbox", auth: { sandbox: fakeAuth } },
    { tier: "live", auth: { sandbox: fakeAuth, live: fakeAuth } },
  ] as const)("preserves the $tier default for path-only requests", async ({ tier, auth }) => {
    const config = makeConfig({
      apiHosts: {
        mock: "mock.example.test",
        sandbox: "sandbox.example.test",
        live: "live.example.test",
      },
      ...auth,
    });
    const deps = makeDeps({ config });

    const result = await handleCallEndpoint({ method: "GET", url: "/accounts" }, deps);

    expect(result.isError).toBeUndefined();
    expect(deps.apicExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ tier, url: `https://${tier}.example.test/accounts` }),
    );
  });

  it("accepts a full sandbox URL and preserves the request arguments", async () => {
    const config = makeConfig({
      apiHosts: { mock: "mock.example.test", sandbox: "sandbox.example.test" },
      sandbox: fakeAuth,
    });
    const deps = makeDeps({ config });
    const args = {
      method: "POST",
      url: "https://sandbox.example.test/accounts",
      queryParams: { page: "1" },
      headers: { accept: "application/json" },
      body: { example: true },
    };

    const result = await handleCallEndpoint(args, deps);

    expect(result.isError).toBeUndefined();
    expect(deps.apicExecutor.execute).toHaveBeenCalledWith({ ...args, tier: "sandbox" });
  });

  it("rejects a path-only request when the selected host is missing", async () => {
    const deps = makeDeps();
    const result = await handleCallEndpoint(
      { method: "GET", url: "/accounts", tier: "sandbox" }, deps,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No host configured");
    expect(deps.apicExecutor.execute).not.toHaveBeenCalled();
  });

  it("rejects a resolved path URL when the configured host is malformed", async () => {
    const deps = makeDeps({ config: makeConfig({ apiHosts: { mock: "invalid host" } }) });
    const result = await handleCallEndpoint({ method: "GET", url: "/accounts" }, deps);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No host configured");
    expect(deps.apicExecutor.execute).not.toHaveBeenCalled();
  });

  it.each([100, 101])("preserves the query parameter limit at %i", async (count) => {
    const deps = makeDeps();
    const queryParams = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`param${index}`, "value"]),
    );
    const result = await handleCallEndpoint(
      { method: "GET", url: "/accounts", queryParams }, deps,
    );

    if (count === 100) {
      expect(result.isError).toBeUndefined();
      expect(deps.apicExecutor.execute).toHaveBeenCalledOnce();
    } else {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Too many query parameters");
      expect(deps.apicExecutor.execute).not.toHaveBeenCalled();
    }
  });

  it("rejects an oversized body before execution", async () => {
    const deps = makeDeps();
    const result = await handleCallEndpoint({
      method: "POST", url: "/accounts", body: { value: "x".repeat(1_048_576) },
    }, deps);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Request body too large");
    expect(deps.apicExecutor.execute).not.toHaveBeenCalled();
  });
});

describe("call_endpoint error privacy", () => {
  const sentinel = "private-sentinel-8675309";

  it.each([
    ["Error", new Error(sentinel)],
    ["string", sentinel],
    ["object", { message: sentinel }],
  ])("does not echo a thrown %s", async (_label, error) => {
    const executor = {
      execute: vi.fn().mockRejectedValue(error),
    } as unknown as ApicExecutor;
    const result = await handleCallEndpoint(
      {
        method: "GET",
        url: `https://test-mock-api.danskebank.com/accounts/${sentinel}?token=${sentinel}`,
      },
      makeDeps({ apicExecutor: executor }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result.content)).toContain("[upstream]");
    expect(JSON.stringify(result.content)).toContain("mock tier");
  });

  it.each([
    { method: sentinel, url: "/accounts" },
    { method: "GET", url: `${sentinel}?token=${sentinel}` },
    { method: "GET", url: `${sentinel}?token=${sentinel}`, tier: "mock" },
    { method: "GET", url: `https://${sentinel}.example.test/accounts` },
    { method: "GET", url: `https://${sentinel}.example.test/accounts`, tier: "mock" },
    { method: "GET", url: `https://${sentinel}@test-mock-api.danskebank.com/accounts` },
    {
      method: "GET",
      url: `https://test-mock-api.danskebank.com/accounts/${sentinel}?token=${sentinel}`,
      tier: "live",
    },
    { method: "GET", url: "/accounts", queryParams: { [sentinel]: 42 } },
  ])("does not echo invalid argument or URL values (%#)", async (args) => {
    const deps = makeDeps();
    const result = await handleCallEndpoint(args, deps);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(deps.apicExecutor.execute).not.toHaveBeenCalled();
  });

  it("keeps token-response details out of the tool result", async () => {
    const config = makeConfig({
      apiHosts: { mock: "mock.example.test", sandbox: "sandbox.example.test" },
      clientId: "client-example",
      sandbox: {
        certPath: "/tmp/example.crt",
        keyPath: "/tmp/example.key",
        tokenUrl: "https://sandbox.example.test/token",
      },
    });
    const tokenManager = new TokenManager({
      config,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(sentinel, { status: 401 })) as never,
      agentFactory: () => ({ async close() {} }) as never,
    });
    const authFetch = vi.fn();
    try {
      const result = await handleCallEndpoint(
        { method: "GET", url: "/accounts", tier: "sandbox" },
        { config, apicExecutor: new ApicExecutor({ tokenManager, authFetch }) },
      );

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(result.content)).toContain("[auth]");
      expect(JSON.stringify(result.content)).toContain("sandbox tier");
      expect(JSON.stringify(result.content)).toContain("401");
      expect(authFetch).not.toHaveBeenCalled();
    } finally {
      await tokenManager.close();
    }
  });

  it("preserves actual API response status, headers and body", async () => {
    const response = {
      status: 500,
      headers: { "content-type": "application/json" },
      body: { account: sentinel },
    };
    const result = await handleCallEndpoint(
      { method: "GET", url: "/accounts", tier: "mock" },
      makeDeps({ apicExecutor: makeExecutor(response) }),
    );

    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject({ statusCode: 500, errorCategory: "upstream" });
    expect(resultPayload(result)).toMatchObject({ tier: "mock", ...response });
  });
});

describe("handleCallEndpoint destination rules", () => {
  const allTiers = makeConfig({
    apiHosts: ALL_HOSTS,
    sandbox: AUTH,
    live: AUTH,
  });

  it.each([
    ["http://", "http://test-api.danskebank.com/v1/accounts"],
    ["a non-default port", "https://test-api.danskebank.com:8443/v1/accounts"],
    ["user:pass@", "https://user:secret-pass@test-api.danskebank.com/v1/accounts"],
    ["a look-alike host", "https://test-api.danskebank.com.evil.example/v1/accounts"],
    ["a host after #@", "https://evil.example#@test-api.danskebank.com/v1/accounts"],
  ])("rejects %s before any request is made", async (_case, url) => {
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      { method: "GET", url },
      makeDeps({ config: allTiers, apicExecutor: executor }),
    );
    expect(result.isError).toBe(true);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(result.content)).not.toContain("secret-pass");
  });

  it("accepts only the servers entry whose host matches the tier, not the first one", async () => {
    // Hosted specs list the mock server first, and every entry has its own base path.
    const servers = [
      "https://test-mock-api.danskebank.com/mock/sandbox/1.5.0",
      "https://test-api.danskebank.com/corporate/api",
      "https://test-sandbox-api.danskebank.com/sandbox-corporate/api",
    ];
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const deps = makeDeps({ config: allTiers, apicExecutor: executor });

    const fromMockEntry = await handleCallEndpoint(
      { method: "GET", url: `${servers[0]}/v1/accounts`, tier: "live" },
      deps,
    );
    expect(fromMockEntry.isError).toBe(true);
    expect(resultPayload(fromMockEntry)).toMatchObject({
      error: {
        category: "validation",
        message: expect.stringContaining(
          'Tier "live" expects host test-api.danskebank.com',
        ),
      },
    });
    const hint = JSON.stringify(fromMockEntry.content);
    expect(hint).toContain(
      "Use the OpenAPI servers entry whose host is test-api.danskebank.com",
    );
    expect(hint).not.toContain("/mock/sandbox/1.5.0");
    expect(executor.execute).not.toHaveBeenCalled();

    const fromLiveEntry = await handleCallEndpoint(
      { method: "GET", url: `${servers[1]}/v1/accounts`, tier: "live" },
      deps,
    );
    expect(fromLiveEntry.isError).toBeUndefined();
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://test-api.danskebank.com/corporate/api/v1/accounts",
        tier: "live",
      }),
    );
  });

  it("rejects a full URL for an explicit tier that has no configured host", async () => {
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      {
        method: "GET",
        url: "https://test-mock-api.danskebank.com/v1/accounts",
        tier: "sandbox",
      },
      makeDeps({
        config: makeConfig({ sandbox: AUTH }),
        apicExecutor: executor,
      }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No host configured");
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("names the usable tiers when a path-only call asks for a tier without a host", async () => {
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      { method: "GET", url: "/v1/accounts", tier: "sandbox" },
      makeDeps({ apicExecutor: executor }),
    );
    expect(result.isError).toBe(true);
    expect(resultPayload(result)).toMatchObject({
      error: {
        category: "validation",
        message:
          'No host configured for tier "sandbox" in this environment. ' +
          "Use one of these tiers: mock, or omit tier to use the default.",
      },
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("rejects an unknown port without echoing the rejected host", async () => {
    const result = await handleCallEndpoint(
      { method: "GET", url: "https://test-api.danskebank.com:8443/v1/accounts" },
      makeDeps({ config: allTiers }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "URL not allowed. The URL does not match a configured tier host.",
    );
    expect(JSON.stringify(result.content)).not.toContain(":8443");
  });

  it.each([
    ["mock", "https://test-mock-api.danskebank.com/v1/accounts"],
    ["sandbox", "https://test-sandbox-api.danskebank.com/v1/accounts"],
    ["live", "https://test-api.danskebank.com/v1/accounts"],
  ] as const)("sends a path-only URL to the %s host", async (tier, expected) => {
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      { method: "GET", url: "/v1/accounts", tier },
      makeDeps({ config: allTiers, apicExecutor: executor }),
    );
    expect(result.isError).toBeUndefined();
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ url: expected, tier }),
    );
  });

  it.each([
    ["mock", "https://test-mock-api.danskebank.com/v1/accounts"],
    ["sandbox", "https://test-sandbox-api.danskebank.com/v1/accounts"],
    ["live", "https://TEST-API.danskebank.com:443/v1/accounts"],
  ] as const)("accepts a full https URL on the %s host", async (tier, url) => {
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      { method: "GET", url },
      makeDeps({ config: allTiers, apicExecutor: executor }),
    );
    expect(result.isError).toBeUndefined();
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://${allTiers.apiHosts[tier]}/v1/accounts`,
        tier,
      }),
    );
  });

  it("keeps a path that starts with // on the configured host", async () => {
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    await handleCallEndpoint(
      { method: "GET", url: "//evil.example/v1/accounts", tier: "mock" },
      makeDeps({ config: allTiers, apicExecutor: executor }),
    );
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://test-mock-api.danskebank.com//evil.example/v1/accounts",
      }),
    );
  });
});

describe("handleCallEndpoint request limits", () => {
  it.each([0, 100])("accepts %i query parameters", async (count) => {
    const queryParams = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`key${index}`, "value"]),
    );
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      { method: "GET", url: "/v1/accounts", queryParams },
      makeDeps({ apicExecutor: executor }),
    );

    expect(result.isError).toBeUndefined();
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams }),
    );
  });

  it("rejects more than 100 query parameters without executing the request", async () => {
    const queryParams = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`key${index}`, "value"]),
    );
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      { method: "GET", url: "/v1/accounts", queryParams },
      makeDeps({ apicExecutor: executor }),
    );

    expect(result.isError).toBe(true);
    expect(resultPayload(result)).toMatchObject({
      error: { category: "validation", message: "Too many query parameters (max 100)." },
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it.each([1_048_575, 1_048_576])("accepts a serialized ASCII body of %i bytes", async (size) => {
    const body = {
      data: "a".repeat(size - JSON.stringify({ data: "" }).length),
    };
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      { method: "POST", url: "/v1/accounts", body },
      makeDeps({ apicExecutor: executor }),
    );

    expect(result.isError).toBeUndefined();
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ body }),
    );
  });

  it("rejects a serialized ASCII body one byte over the limit without executing the request", async () => {
    const body = {
      data: "a".repeat(1_048_577 - JSON.stringify({ data: "" }).length),
    };
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      { method: "POST", url: "/v1/accounts", body },
      makeDeps({ apicExecutor: executor }),
    );

    expect(result.isError).toBe(true);
    expect(resultPayload(result)).toMatchObject({
      error: {
        category: "validation",
        message: "Request body too large (1048577 bytes, max 1048576).",
      },
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it.each(["€", "😀", "æ"])(
    "accepts a multibyte %s body of exactly 1 MiB in UTF-8",
    async (character) => {
      const available = 1_048_576 - Buffer.byteLength(JSON.stringify({ data: "" }), "utf8");
      const width = Buffer.byteLength(character, "utf8");
      const body = {
        data: character.repeat(Math.floor(available / width)) + "a".repeat(available % width),
      };
      const executor = makeExecutor({ status: 200, headers: {}, body: {} });

      expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBe(1_048_576);
      const result = await handleCallEndpoint(
        { method: "POST", url: "/v1/accounts", body },
        makeDeps({ apicExecutor: executor }),
      );

      expect(result.isError).toBeUndefined();
      expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({ body }));
    },
  );

  it.each(["€", "😀", "æ"])(
    "rejects a multibyte %s body one UTF-8 byte over 1 MiB before execution",
    async (character) => {
      const available = 1_048_577 - Buffer.byteLength(JSON.stringify({ data: "" }), "utf8");
      const width = Buffer.byteLength(character, "utf8");
      const body = {
        data: character.repeat(Math.floor(available / width)) + "a".repeat(available % width),
      };
      const executor = makeExecutor({ status: 200, headers: {}, body: {} });

      expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBe(1_048_577);
      const result = await handleCallEndpoint(
        { method: "POST", url: "/v1/accounts", body },
        makeDeps({ apicExecutor: executor }),
      );

      expect(result.isError).toBe(true);
      expectStructuredResult(result);
      expect(resultPayload(result)).toMatchObject({
        error: {
          category: "validation",
          retryable: false,
          nextStep: expect.stringContaining("get_endpoint_details"),
          message: "Request body too large (1048577 bytes, max 1048576).",
        },
      });
      expect(executor.execute).not.toHaveBeenCalled();
    },
  );

  it("reports the actual byte size of a multibyte body", async () => {
    const body = { data: "€".repeat(400_000) };
    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      { method: "POST", url: "/v1/accounts", body },
      makeDeps({ apicExecutor: executor }),
    );

    expect(result.isError).toBe(true);
    expectStructuredResult(result);
    expect(resultPayload(result)).toMatchObject({
      error: {
        category: "validation",
        retryable: false,
        nextStep: expect.stringContaining("get_endpoint_details"),
        message: `Request body too large (${bytes} bytes, max 1048576).`,
      },
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("reports the query limit before body or destination errors", async () => {
    const queryParams = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`key${index}`, "value"]),
    );
    const executor = makeExecutor({ status: 200, headers: {}, body: {} });
    const result = await handleCallEndpoint(
      {
        method: "POST",
        url: "not-a-url",
        queryParams,
        body: { data: "a".repeat(1_048_577) },
      },
      makeDeps({ apicExecutor: executor }),
    );

    expect(result.isError).toBe(true);
    expect(resultPayload(result)).toMatchObject({
      error: { category: "validation", message: "Too many query parameters (max 100)." },
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

describe("call_endpoint tool contract", () => {
  const recovery = {
    category: "validation",
    retryable: false,
    nextStep: "Check the request.",
    message: "Invalid request.",
  };
  const response = { tier: "mock", status: 200, headers: {}, body: null };

  it.each([
    {},
    { apiHosts: ALL_HOSTS, sandbox: AUTH },
    { apiHosts: ALL_HOSTS, sandbox: AUTH, live: AUTH },
  ])("advertises explicit mutation safety hints in a closed domain for each tier (%#)", (config) => {
    const definition = buildCallEndpointToolDefinition(makeConfig(config));
    expect(definition.title).toBe("Call API endpoint");
    expect(definition.annotations).toEqual({
      title: definition.title,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("keeps the legacy definition's metadata aligned with the dynamic definition", () => {
    const definition = buildCallEndpointToolDefinition(makeConfig());
    expect(callEndpointToolDefinition).toMatchObject({
      title: definition.title,
      annotations: definition.annotations,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
    });
  });

  it.each([
    response,
    { ...response, status: 404, error: recovery },
    { error: recovery },
    { tier: "live", error: recovery },
  ])("advertises an output schema accepting each result envelope (%#)", (payload) => {
    const { outputSchema } = buildCallEndpointToolDefinition(makeConfig());
    expect(outputSchema).toMatchObject({ type: "object" });
    const validate = new AjvJsonSchemaValidator().getValidator(outputSchema);
    expect(validate(payload)).toMatchObject({ valid: true });
  });

  it.each([
    {},
    { ...response, tier: "unknown" },
    { ...response, status: "200" },
    { ...response, status: 99 },
    { ...response, status: 600 },
    { ...response, status: 200.5 },
    { ...response, headers: { invalid: 1 } },
    { tier: "mock", status: 200, headers: {} },
    { status: 200, headers: {}, body: null },
    { error: { ...recovery, category: "unknown" } },
    { error: { ...recovery, retryable: "false" } },
    { error: { ...recovery, nextStep: undefined } },
    { error: { ...recovery, message: undefined } },
    { error: recovery, status: 200 },
    { error: recovery, headers: {} },
    { error: recovery, body: null },
  ])("rejects malformed or incomplete structured envelopes (%#)", (payload) => {
    const { outputSchema } = buildCallEndpointToolDefinition(makeConfig());
    const validate = new AjvJsonSchemaValidator().getValidator(outputSchema);
    expect(validate(payload)).toMatchObject({ valid: false });
  });

  it.each([
    {
      status: 201,
      error: undefined,
      meta: { statusCode: 201 },
      isError: undefined,
    },
    {
      status: 404,
      error: {
        category: "not_found",
        retryable: false,
        nextStep: "Use get_endpoint_details to verify the selected tier's base path, operation and resource identifier.",
      },
      meta: { statusCode: 404, errorCategory: "not_found" },
      isError: true,
    },
  ])("preserves the exact legacy HTTP $status text and metadata", async ({ status, error, meta, isError }) => {
    const apiResponse = {
      status,
      headers: { "content-type": "application/json", "x-request-id": "example" },
      body: { accounts: ["example-account"] },
    };
    const result = await handleCallEndpoint(
      { method: "GET", url: "/accounts", tier: "mock" },
      makeDeps({ apicExecutor: makeExecutor(apiResponse) }),
    );
    expect(result.content).toEqual([{
      type: "text",
      text: JSON.stringify({ tier: "mock", ...apiResponse, ...(error ? { error } : {}) }, null, 2),
    }]);
    expect(result._meta).toEqual(meta);
    expect(result.isError).toBe(isError);
    expectStructuredResult(result);
  });

  it("preserves the exact legacy proxy-error text and metadata", async () => {
    const result = await handleCallEndpoint({}, makeDeps());
    expect(result.content).toEqual([{
      type: "text",
      text: JSON.stringify({
        error: {
          category: "validation",
          retryable: false,
          nextStep: "Check the tool schema and get_endpoint_details, then correct the request before retrying.",
          message: "Invalid arguments. Check method, url, tier, queryParams, headers and body against the tool schema.",
        },
      }, null, 2),
    }]);
    expect(result._meta).toEqual({ errorCategory: "validation" });
    expect(result.isError).toBe(true);
    expectStructuredResult(result);
  });
});

describe("call_endpoint description", () => {
  it.each([
    {},
    { apiHosts: ALL_HOSTS, sandbox: AUTH },
    { apiHosts: ALL_HOSTS, sandbox: AUTH, live: AUTH },
  ])("documents provenance and success semantics for each configuration (%#)", (config) => {
    const text = getToolDescription(makeConfig(config));
    expect(text).toContain("tier");
    expect(text).toContain("HTTP 400");
    expect(text).toContain("isError");
    expect(text).toContain("2xx");
    expect(text).toContain("retryable");
  });

  it("lists every tier and names live as the default when live is configured", () => {
    const text = getToolDescription(
      makeConfig({ apiHosts: ALL_HOSTS, sandbox: AUTH, live: AUTH }),
    );
    expect(text).toContain("Default tier: live.");
    expect(text).toContain(
      "live = test-api.danskebank.com (real data, GET only)",
    );
    expect(text).toContain("sandbox = test-sandbox-api.danskebank.com (test data)");
    expect(text).toContain(
      "mock = test-mock-api.danskebank.com (sample data, no auth)",
    );
  });

  it("defaults to sandbox without claiming real data when live has no credentials", () => {
    const text = getToolDescription(
      makeConfig({ apiHosts: ALL_HOSTS, sandbox: AUTH }),
    );
    expect(text).toContain("Default tier: sandbox.");
    expect(text).not.toContain("real data");
  });

  it("defaults to mock without claiming real data in a mock-only setup", () => {
    const text = getToolDescription(makeConfig());
    expect(text).toContain("Default tier: mock.");
    expect(text).not.toContain("real data");
    expect(text).not.toContain("live =");
  });

  it("picks the servers entry by host, never by its position", () => {
    const definition = JSON.stringify(
      buildCallEndpointToolDefinition(
        makeConfig({ apiHosts: ALL_HOSTS, live: AUTH }),
      ),
    );
    expect(definition).not.toMatch(/servers\[0\]/);
    expect(definition).toContain("whatever its position in the list");
  });
});
