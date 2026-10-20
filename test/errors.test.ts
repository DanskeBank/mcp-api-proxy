import { describe, expect, it } from "vitest";
import { ProxyError, auditErrorCategory, safeErrorMessage } from "../src/errors.js";

describe("safe error messages", () => {
  it("retains a known category, tier and real HTTP status", () => {
    const error = new ProxyError("auth", { tier: "sandbox", statusCode: 401 });

    expect(safeErrorMessage(error, "internal")).toBe(error.message);
    expect(error.message).toContain("[auth] sandbox tier (HTTP 401)");
    expect(error.category).toBe("auth");
    expect(error.statusCode).toBe(401);
  });

  it.each([undefined, 0, -1, 600, 401.5, Infinity, NaN])(
    "does not invent a status for %s",
    (statusCode) => {
      const error = new ProxyError("upstream", { statusCode });
      expect(error.message).not.toContain("HTTP");
      expect(error.statusCode).toBeUndefined();
    },
  );

  it("never trusts a category prefix in an arbitrary exception", () => {
    const sentinel = "private-exception-sentinel-123";
    const message = safeErrorMessage(new Error(`[auth] ${sentinel}`), "upstream", "mock");

    expect(message).toContain("[upstream] mock tier");
    expect(message).not.toContain(sentinel);
  });

  it("uses proxy-owned configuration guidance", () => {
    const error = new ProxyError("configuration", {
      hint: "Check MCP_HTTP_PORT.",
    });

    expect(error.message).toBe("[configuration]: Check MCP_HTTP_PORT.");
  });

  it.each(["auth", "configuration", "upstream", "internal", "validation", "not_found", "rate_limited"])(
    "extracts only the %s category for audit",
    (category) => {
      expect(auditErrorCategory(`[${category}] private-error-text`)).toBe(category);
    },
  );

  it.each(["private-error-text", "[unknown] private-error-text", ""])(
    "uses a generic category for unrecognized error text (%#)",
    (message) => {
      expect(auditErrorCategory(message)).toBe("tool_error");
    },
  );
});