import type { Tier } from "./types/index.js";

export const ERROR_CATEGORIES = [
  "auth", "configuration", "upstream", "internal",
  "validation", "not_found", "rate_limited",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

const MESSAGES: Record<ErrorCategory, string> = {
  auth: "Authentication failed. Check CLIENT_ID, CLIENT_CERT_PEM, CLIENT_KEY_PEM and API access.",
  configuration: "Proxy configuration is invalid. Check the named settings and restart the proxy.",
  upstream: "The upstream request failed. Check connectivity and the service configuration.",
  internal: "The proxy could not complete the operation.",
  validation: "The request is invalid. Check the tool schema and API specification.",
  not_found: "The resource was not found. Check the API specification and resource identifier.",
  rate_limited: "The API rate limit was reached. Respect Retry-After before retrying.",
};

interface ProxyErrorOptions {
  tier?: Tier;
  statusCode?: number;
  cause?: unknown;
  /** Proxy-owned guidance, never upstream text or user-supplied values. */
  hint?: string;
}

export class ProxyError extends Error {
  readonly category: ErrorCategory;
  readonly statusCode?: number;

  constructor(category: ErrorCategory, options: ProxyErrorOptions = {}) {
    const { tier, statusCode, cause, hint } = options;
    const validStatus =
      typeof statusCode === "number" && Number.isInteger(statusCode) &&
      statusCode >= 100 && statusCode <= 599 ? statusCode : undefined;
    const status = validStatus === undefined ? "" : ` (HTTP ${validStatus})`;
    const target = tier ? ` ${tier} tier` : "";
    super(`[${category}]${target}${status}: ${hint ?? MESSAGES[category]}`, {
      cause,
    });
    this.name = "ProxyError";
    this.category = category;
    this.statusCode = validStatus;
  }
}

export function safeErrorMessage(
  error: unknown,
  fallback: ErrorCategory,
  tier?: Tier,
): string {
  return error instanceof ProxyError
    ? error.message
    : new ProxyError(fallback, { tier }).message;
}

export function auditErrorCategory(
  message: string,
): ErrorCategory | "tool_error" {
  return ERROR_CATEGORIES.find((category) => message.startsWith(`[${category}]`)) ?? "tool_error";
}