import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import type { Config } from "../config/config.js";
import type { ApicExecutor } from "../clients/apic-executor.js";
import { ERROR_CATEGORIES, ProxyError, safeErrorMessage, type ErrorCategory } from "../errors.js";
import type { ApiResponse, Tier } from "../types/index.js";

export const CALL_ENDPOINT_TOOL_NAME = "call_endpoint";
const CALL_ENDPOINT_TOOL_TITLE = "Call API endpoint";

export const callEndpointSchema = z
  .object({
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .describe("HTTP method"),
    url: z
      .string()
      .describe(
        "Request path: the path of the OpenAPI `servers` entry for the target tier, followed by the operation path. " +
          "Pick the entry whose host is the tier's host in the tool description, whatever its position in the list. " +
          "Example: entry `https://api.danskebank.com/corporate/api` and operation `/v1/accounts/list` give " +
          "`/corporate/api/v1/accounts/list`. The operation path alone returns 404. " +
          "A full URL is accepted only as https:// on the tier's host, without port or credentials.",
      ),
    tier: z
      .enum(["live", "sandbox", "mock"])
      .optional()
      .describe(
        "Target tier: live (real data), sandbox (test data) or mock (sample data). " +
          "Omit it to use the default tier named in the tool description. " +
          "Choose mock or sandbox only when the user asks to test.",
      ),
    queryParams: z
      .record(z.string())
      .optional()
      .describe("Query string parameters"),
    headers: z
      .record(z.string())
      .optional()
      .describe(
        "Optional extra headers. Authorization and Content-Type are added automatically — do NOT include them here.",
      ),
    body: z
      .record(z.unknown())
      .optional()
      .describe("Request body for POST/PUT/PATCH"),
  })
  .superRefine((val, ctx) => {
    if (val.body && (val.method === "GET" || val.method === "DELETE")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: `Request body is not allowed for ${val.method} requests.`,
      });
    }
  });

export type CallEndpointArgs = z.infer<typeof callEndpointSchema>;

// Least-privileged first, so a host shared by two tiers never resolves to an authenticated one.
const TIERS: readonly Tier[] = ["mock", "sandbox", "live"];

const TIER_DATA: Record<Tier, string> = {
  mock: "sample data, no auth",
  sandbox: "test data",
  live: "real data, GET only",
};

const URL_RULE =
  "Pass the path (starting with /), or a full https:// URL on the configured host of the tier.";

/** The configured host of `tier` as `URL.host` reports it (lowercase, default port dropped). */
function configuredHost(config: Config, tier: Tier): string | undefined {
  const host = config.apiHosts[tier];
  if (!host) return undefined;
  try {
    return new URL(`https://${host}`).host;
  } catch {
    return undefined;
  }
}

/** A tier can be called when it has a host and, for sandbox and live, credentials. */
function isUsable(config: Config, tier: Tier): boolean {
  if (!configuredHost(config, tier)) return false;
  return tier === "mock" || Boolean(config[tier]);
}

export function getUsableTiers(config: Config): Tier[] {
  return TIERS.filter((tier) => isUsable(config, tier));
}

export function getDefaultTier(config: Config): Tier {
  if (isUsable(config, "live")) return "live";
  if (isUsable(config, "sandbox")) return "sandbox";
  return "mock";
}

function noHostError(config: Config, tier: Tier): { error: string } {
  const usable = getUsableTiers(config).join(", ");
  return {
    error:
      `No host configured for tier "${tier}" in this environment. ` +
      `Use one of these tiers: ${usable}, or omit tier to use the default.`,
  };
}

/**
 * Builds the tool description dynamically so the LLM knows the tiers and
 * hosts of this deployment and which tier is the default.
 */
export function getToolDescription(config: Config): string {
  const tiers = getUsableTiers(config)
    .map((tier) => `${tier} = ${configuredHost(config, tier)} (${TIER_DATA[tier]})`)
    .join("; ");
  const tierByDefault = getDefaultTier(config);
  return (
    "Execute a request against a Danske Bank API. Only Premium APIs are supported " +
    "(client_credentials grant, no PSD2 consent flows). " +
    `Tiers: ${tiers}. Default tier: ${tierByDefault}. ` +
    (tierByDefault === "live"
      ? "Use tier='mock' or tier='sandbox' only when the user asks to test. "
      : "") +
    "HOW TO BUILD `url`: in the API's OpenAPI spec, pick the `servers` entry of the tier you call: " +
    "the entry whose host is that tier's host above, whatever its position in the list (mock is often first). " +
    "Append the operation path to the path of that entry. " +
    "Example: entry `https://api.danskebank.com/corporate/api` + operation `/v1/accounts/list` " +
    "\u2192 url `/corporate/api/v1/accounts/list`. The operation path alone returns 404. " +
    "A full URL also works if it is https:// on the tier's host, without port or credentials. " +
    "The proxy adds the client certificate and bearer token for sandbox and live. " +
    "Results include the resolved tier, status, headers and body as structuredContent and matching JSON text. " +
    "Only HTTP 2xx is API success; " +
    "a redirect is not success. HTTP 400 and above sets isError with error.category, " +
    "error.retryable and error.nextStep. Check the expected response body before reporting business success."
  );
}

const RECOVERY_STEPS: Record<ErrorCategory, string> = {
  validation: "Check the tool schema and get_endpoint_details, then correct the request before retrying.",
  auth: "Check client credentials, requested scope (TOKEN_SCOPE) and API access before retrying.",
  not_found: "Use get_endpoint_details to verify the selected tier's base path, operation and resource identifier.",
  rate_limited: "Wait according to the Retry-After response header, then follow the API's retry policy.",
  upstream: "Check connectivity and service availability, then follow the API's retry policy.",
  configuration: "Check the named proxy settings, credential files and configured tier; restart after correcting them.",
  internal: "Review safe proxy diagnostics and restart or contact support before retrying.",
};

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function recoveryDetails(category: ErrorCategory, retryable: boolean) {
  const warning = !retryable && (category === "upstream" || category === "rate_limited")
    ? " Do not automatically replay the request; confirm its outcome before repeating it."
    : "";
  return { category, retryable, nextStep: RECOVERY_STEPS[category] + warning };
}

function canRetry(method: CallEndpointArgs["method"], category: ErrorCategory, status?: number): boolean {
  return method === "GET" && (category === "upstream" || category === "rate_limited") &&
    (status === undefined || RETRYABLE_HTTP_STATUSES.has(status));
}

function responseCategory(status: number): ErrorCategory {
  switch (status) {
    case 401:
    case 403:
      return "auth";
    case 404:
      return "not_found";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 || status === 408 ? "upstream" : "validation";
  }
}

function errorResult(
  message: string,
  category: ErrorCategory = "validation",
  tier?: Tier,
  retryable = false,
): CallToolResult {
  const structuredContent = {
    ...(tier ? { tier } : {}),
    error: { ...recoveryDetails(category, retryable), message },
  };
  return {
    _meta: { errorCategory: category },
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true,
  };
}

export interface CallEndpointDeps {
  config: Config;
  apicExecutor: ApicExecutor;
}

export type Destination = { tier: Tier; url: string } | { error: string };

/**
 * Resolves the tier and the full URL of a call, or the reason to reject it.
 * Credentials may only go to https URLs on the exact configured host of the
 * resolved tier, so scheme, userinfo, host and port are all checked.
 */
export function resolveDestination(
  url: string,
  requestedTier: Tier | undefined,
  config: Config,
): Destination {
  let tier = requestedTier;
  let target = url;
  if (url.startsWith("/")) {
    tier ??= getDefaultTier(config);
    const host = configuredHost(config, tier);
    if (!host) return noHostError(config, tier);
    target = `https://${host}${url}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { error: `Invalid URL. ${URL_RULE}` };
  }
  if (parsed.username || parsed.password) {
    return { error: `URLs with credentials (user:password@) are not allowed. ${URL_RULE}` };
  }
  if (parsed.protocol !== "https:") {
    return { error: `Only https URLs are allowed. ${URL_RULE}` };
  }

  tier ??= TIERS.find((t) => configuredHost(config, t) === parsed.host);
  if (!tier) {
    const allowed = TIERS.map((t) => configuredHost(config, t)).filter(Boolean);
    return {
      error:
        `URL not allowed. The URL does not match a configured tier host. ${URL_RULE} ` +
        `Configured hosts: ${allowed.join(", ")}.`,
    };
  }
  const expectedHost = configuredHost(config, tier);
  if (!expectedHost) return noHostError(config, tier);
  if (parsed.host !== expectedHost) {
    // Repeating the rejected URL's path would steer the agent to another tier's base path.
    return {
      error:
        `Tier "${tier}" expects host ${expectedHost}. ` +
        `Use the OpenAPI servers entry whose host is ${expectedHost}: pass its path followed by the operation path.`,
    };
  }
  return { tier, url: parsed.href };
}

/** Max request body size (1 MiB of serialized UTF-8). */
const MAX_REQUEST_BODY_BYTES = 1_048_576;
/** Max number of query parameters to forward. */
const MAX_QUERY_PARAMS = 100;

function invalidArguments(error: z.ZodError): CallToolResult {
  const bodyIssue = error.issues.find(
    (issue) => issue.code === "custom" && issue.path[0] === "body",
  );
  return errorResult(
    bodyIssue
      ? `Invalid arguments: ${bodyIssue.message}`
      : "Invalid arguments. Check method, url, tier, queryParams, headers and body against the tool schema.",
  );
}

function requestLimitError({ queryParams, body }: CallEndpointArgs): string | undefined {
  if (queryParams && Object.keys(queryParams).length > MAX_QUERY_PARAMS) {
    return `Too many query parameters (max ${MAX_QUERY_PARAMS}).`;
  }

  if (body) {
    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      return `Request body too large (${bytes} bytes, max ${MAX_REQUEST_BODY_BYTES}).`;
    }
  }
  return undefined;
}

function tierError(method: CallEndpointArgs["method"], tier: Tier, config: Config): ProxyError | undefined {
  if (tier === "live" && method !== "GET") {
    return new ProxyError("validation", {
      tier, hint: `Live is read-only. Only GET requests are allowed against ${config.apiHosts.live}.`,
    });
  }
  if (tier === "live" && !config.live) {
    return new ProxyError("configuration", {
      tier, hint: "Live client certificate not configured. Set CLIENT_CERT_PEM and CLIENT_KEY_PEM (and CLIENT_ID) to enable live API calls.",
    });
  }
  if (tier === "sandbox" && !config.sandbox) {
    return new ProxyError("configuration", {
      tier, hint: "Sandbox client credentials not configured. Set CLIENT_ID, CLIENT_CERT_PEM and CLIENT_KEY_PEM to enable sandbox API calls.",
    });
  }
  return undefined;
}

function responseResult(response: ApiResponse, tier: Tier, method: CallEndpointArgs["method"]): CallToolResult {
  const category = responseCategory(response.status);
  const error = response.status >= 400
    ? recoveryDetails(category, canRetry(method, category, response.status))
    : undefined;
  const structuredContent = {
    tier,
    status: response.status,
    headers: response.headers,
    body: response.body,
    ...(error ? { error } : {}),
  };
  return {
    _meta: { statusCode: response.status, ...(error ? { errorCategory: category } : {}) },
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(error ? { isError: true } : {}),
  };
}

export async function handleCallEndpoint(
  rawArgs: unknown,
  deps: CallEndpointDeps,
): Promise<CallToolResult> {
  const parsed = callEndpointSchema.safeParse(rawArgs);
  if (!parsed.success) return invalidArguments(parsed.error);
  const args = parsed.data;
  const limitError = requestLimitError(args);
  if (limitError) return errorResult(limitError);

  const destination = resolveDestination(args.url, args.tier, deps.config);
  if ("error" in destination) return errorResult(destination.error);
  const { tier, url } = destination;
  const rejectedTier = tierError(args.method, tier, deps.config);
  if (rejectedTier) return errorResult(rejectedTier.message, rejectedTier.category, tier);

  const { method, queryParams, headers, body } = args;
  try {
    const response = await deps.apicExecutor.execute({
      method,
      url,
      queryParams,
      headers,
      body,
      tier,
    });
    return responseResult(response, tier, method);
  } catch (err) {
    const category = err instanceof ProxyError ? err.category : "upstream";
    const status = err instanceof ProxyError ? err.statusCode : undefined;
    return errorResult(
      safeErrorMessage(err, "upstream", tier), category, tier, canRetry(method, category, status),
    );
  }
}

// Generated from `callEndpointSchema` so the wire schema and the runtime
// validator can never drift. Validated at module load to catch schema drift early.
const _generatedSchema = zodToJsonSchema(callEndpointSchema, {
  target: "openApi3",
  $refStrategy: "none",
}) as Record<string, unknown>;

if (_generatedSchema.type !== "object") {
  throw new Error(
    `Expected callEndpointSchema to produce an object JSON schema, got type="${_generatedSchema.type}"`,
  );
}

const _inputSchema = _generatedSchema as { type: "object" } & Record<
  string,
  unknown
>;

const _errorSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...ERROR_CATEGORIES] },
    retryable: { type: "boolean" },
    nextStep: { type: "string" },
    message: { type: "string" },
  },
  required: ["category", "retryable", "nextStep"],
  additionalProperties: false,
} satisfies JsonSchemaType;

const _tierSchema = { type: "string", enum: [...TIERS] } satisfies JsonSchemaType;

const _outputSchema: JsonSchemaType & NonNullable<Tool["outputSchema"]> = {
  type: "object",
  anyOf: [
    {
      type: "object",
      properties: {
        tier: _tierSchema,
        status: { type: "integer", minimum: 100, maximum: 599 },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { description: "The original API response body, including JSON values, raw text or null." },
        error: _errorSchema,
      },
      required: ["tier", "status", "headers", "body"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        tier: _tierSchema,
        error: { ..._errorSchema, required: [..._errorSchema.required, "message"] },
      },
      required: ["error"],
      additionalProperties: false,
    },
  ],
};

/**
 * Build the tool definition with a description tailored to the current
 * deployment (so the LLM knows which tier is the default).
 */
export function buildCallEndpointToolDefinition(config: Config) {
  return {
    name: CALL_ENDPOINT_TOOL_NAME,
    title: CALL_ENDPOINT_TOOL_TITLE,
    description: getToolDescription(config),
    inputSchema: _inputSchema,
    outputSchema: _outputSchema,
    annotations: {
      title: CALL_ENDPOINT_TOOL_TITLE,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  } satisfies Tool;
}

/**
 * @deprecated Use `buildCallEndpointToolDefinition(config)` for tier-aware descriptions.
 * Kept for backward compat with tests that don't need a config.
 */
export const callEndpointToolDefinition = buildCallEndpointToolDefinition({
  apiHosts: { mock: "mock-api.danskebank.com" },
} as Config);
