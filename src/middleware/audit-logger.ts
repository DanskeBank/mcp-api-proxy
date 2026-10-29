import { auditErrorCategory } from "../errors.js";

/**
 * Context automatically populated by the proxy from the MCP request.
 * Always available — no customer configuration needed.
 */
export interface RequestContext {
  /** MCP session ID (available in HTTP mode) */
  sessionId?: string;
  /** JSON-RPC request ID */
  requestId: string | number;
  /** Environment the proxy is running in */
  env: string;
}

/**
 * Populated for call_endpoint invocations.
 */
export interface ApiCallDetails {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Target URL */
  url: string;
  /** Which host tier: mock, sandbox, or live */
  targetTier: "mock" | "sandbox" | "live";
}

export interface AuditEvent {
  timestamp: Date;
  /** MCP tool name */
  tool: string;
  /** Request context from the MCP transport */
  context: RequestContext;
  /** Present only for call_endpoint */
  apiCall?: ApiCallDetails;
  /** Result info — populated after execution */
  result?: {
    statusCode?: number;
    durationMs: number;
    error?: string;
  };
}

export interface AuditLogger {
  /** Called before a tool executes. */
  logToolCall(event: AuditEvent): Promise<void>;
  /** Called after a tool completes (or fails). */
  logToolResult(event: AuditEvent): Promise<void>;
}

/**
 * Default: logs structured JSON to stderr (the only safe output channel
 * for MCP stdio servers, since stdout carries the JSON-RPC protocol).
 *
 * For central deployments, implement the AuditLogger interface with your
 * own transport (Splunk, ELK, AppDynamics, etc.).
 */
export class ConsoleAuditLogger implements AuditLogger {
  async logToolCall(event: AuditEvent): Promise<void> {
    console.error(
      JSON.stringify({
        level: "info",
        type: "tool_call",
        timestamp: event.timestamp.toISOString(),
        tool: event.tool,
        sessionId: event.context.sessionId,
        requestId: event.context.requestId,
        env: event.context.env,
        ...(event.apiCall && {
          method: event.apiCall.method,
          ...redactUrl(event.apiCall.url),
          targetTier: event.apiCall.targetTier,
        }),
      }),
    );
  }

  async logToolResult(event: AuditEvent): Promise<void> {
    console.error(
      JSON.stringify({
        level: event.result?.error ? "error" : "info",
        type: "tool_result",
        timestamp: event.timestamp.toISOString(),
        tool: event.tool,
        sessionId: event.context.sessionId,
        requestId: event.context.requestId,
        env: event.context.env,
        ...(event.apiCall && {
          method: event.apiCall.method,
          ...redactUrl(event.apiCall.url),
          targetTier: event.apiCall.targetTier,
        }),
        ...(event.result && {
          durationMs: event.result.durationMs,
          ...(event.result.statusCode != null && {
            statusCode: event.result.statusCode,
          }),
          ...(event.result.error && { error: auditErrorCategory(event.result.error) }),
        }),
      }),
    );
  }
}

// Without route templates, even a letters-only path segment can identify a customer.
export function redactUrl(url: string): { urlPath: string; queryKeys?: string[] } {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { urlPath: "[redacted]" };
    }
    const queryKeys = [...u.searchParams.keys()];
    const path = u.pathname.split("/").map((segment) => segment ? "[redacted]" : "").join("/");
    return {
      urlPath: `${u.protocol}//${u.host}${path}`,
      ...(queryKeys.length > 0 ? { queryKeys } : {}),
    };
  } catch {
    return { urlPath: "[redacted]" };
  }
}
