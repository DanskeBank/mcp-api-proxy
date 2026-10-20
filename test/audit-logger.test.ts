import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleAuditLogger, type AuditEvent } from "../src/middleware/audit-logger.js";

const sentinel = "private-sentinel-8675309";

function event(url: string): AuditEvent {
  return {
    timestamp: new Date("2026-01-01T00:00:00Z"),
    tool: "call_endpoint",
    context: { env: "test", requestId: 1, sessionId: "test-session" },
    apiCall: { method: "GET", url, targetTier: "mock" },
    result: { durationMs: 12, statusCode: 401, error: `[auth] ${sentinel}` },
  };
}

describe("ConsoleAuditLogger privacy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs category and redacted URL without mutating the custom logger event", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auditEvent = event(
      `https://user:${sentinel}@mock.example.test/accounts/${sentinel}/entries?token=${sentinel}#${sentinel}`,
    );
    const original = structuredClone(auditEvent);
    const logger = new ConsoleAuditLogger();

    await logger.logToolCall(auditEvent);
    await logger.logToolResult(auditEvent);

    const text = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("accounts");
    expect(text).not.toContain("user:");
    const result = JSON.parse(String(log.mock.calls[1][0]));
    expect(result).toMatchObject({
      urlPath: "https://mock.example.test/[redacted]/[redacted]/[redacted]",
      queryKeys: ["token"],
      error: "auth",
      targetTier: "mock",
      statusCode: 401,
      durationMs: 12,
    });
    expect(auditEvent).toEqual(original);
  });

  it.each([
    `${sentinel}?token=${sentinel}`,
    `/accounts/${sentinel}?token=${sentinel}`,
    `mailto:${sentinel}@example.test`,
  ])("does not echo a malformed, relative or non-HTTP URL (%#)", async (url) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleAuditLogger();

    await logger.logToolCall(event(url));
    await logger.logToolResult(event(url));

    expect(log.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain(sentinel);
  });

  it("does not echo an unknown error's text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auditEvent = event("https://mock.example.test/");
    auditEvent.result!.error = sentinel;

    await new ConsoleAuditLogger().logToolResult(auditEvent);

    const result = JSON.parse(String(log.mock.calls[0][0]));
    expect(result.error).toBe("tool_error");
    expect(result.urlPath).toBe("https://mock.example.test/");
    expect(result.queryKeys).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("logs a successful event without inventing an error or HTTP status", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auditEvent = event("https://mock.example.test/");
    auditEvent.apiCall = undefined;
    auditEvent.result = { durationMs: 5 };

    await new ConsoleAuditLogger().logToolResult(auditEvent);

    const result = JSON.parse(String(log.mock.calls[0][0]));
    expect(result.level).toBe("info");
    expect(result.error).toBeUndefined();
    expect(result.statusCode).toBeUndefined();
    expect(result.urlPath).toBeUndefined();
  });
});