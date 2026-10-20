import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpClient } from "../clients/mcp-client.js";
import type { Config } from "../config/config.js";
import { ProxyError, auditErrorCategory, safeErrorMessage } from "../errors.js";
import {
  CALL_ENDPOINT_TOOL_NAME,
  callEndpointSchema,
  buildCallEndpointToolDefinition,
  handleCallEndpoint,
  resolveDestination,
  type CallEndpointArgs,
  type CallEndpointDeps,
} from "./call-endpoint.js";
import type {
  AuditLogger,
  AuditEvent,
  ApiCallDetails,
  RequestContext,
} from "../middleware/audit-logger.js";

export interface RegisterToolsOptions {
  auditLogger?: AuditLogger;
}

async function safeAudit(logger: AuditLogger | undefined, event: AuditEvent): Promise<void> {
  if (!logger) return;
  try {
    if (event.result) await logger.logToolResult(event);
    else await logger.logToolCall(event);
  } catch {
    console.error("[audit] [internal] Audit logger failed; tool execution is unchanged.");
  }
}

function resolveTargetTier(args: CallEndpointArgs, config: Config): ApiCallDetails["targetTier"] | undefined {
  const destination = resolveDestination(args.url, args.tier, config);
  return "error" in destination ? undefined : destination.tier;
}

function apiCallDetails(name: string, args: unknown, config: Config): ApiCallDetails | undefined {
  if (name !== CALL_ENDPOINT_TOOL_NAME) return undefined;
  const parsed = callEndpointSchema.safeParse(args);
  if (!parsed.success) return undefined;
  const tier = resolveTargetTier(parsed.data, config);
  if (!tier) return undefined;
  return { method: parsed.data.method, url: parsed.data.url, targetTier: tier };
}

function httpStatus(result: CallToolResult): number | undefined {
  const statusCode = result._meta?.statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function sanitizeUpstreamResult(result: CallToolResult): CallToolResult {
  if (!result.isError) return result;
  const statusCode = httpStatus(result);
  return {
    ...(statusCode === undefined ? {} : { _meta: { statusCode } }),
    content: [{ type: "text", text: new ProxyError("upstream", { statusCode }).message }],
    isError: true,
  };
}

async function executeTool(
  name: string,
  args: Record<string, unknown> | undefined,
  mcpClient: McpClient | null,
  deps: CallEndpointDeps,
): Promise<CallToolResult> {
  if (name === CALL_ENDPOINT_TOOL_NAME) return handleCallEndpoint(args, deps);
  if (mcpClient) return sanitizeUpstreamResult(await mcpClient.callTool(name, args));
  return {
    content: [{ type: "text", text:
      "Unknown tool. The upstream discovery server is not connected; " +
      `only "${CALL_ENDPOINT_TOOL_NAME}" is available.`,
    }],
    isError: true,
  };
}

function resultDetails(result: CallToolResult, durationMs: number): AuditEvent["result"] {
  const statusCode = httpStatus(result);
  const category = result._meta?.errorCategory;
  const categoryMessage = typeof category === "string" ? `[${category}]` : undefined;
  const error = categoryMessage === undefined
    ? extractErrorText(result) ?? "tool returned isError"
    : `[${auditErrorCategory(categoryMessage)}]`;
  return {
    durationMs,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(result.isError ? { error } : {}),
  };
}

/**
 * Wires the proxy server's tools/list and tools/call handlers.
 *
 * - Discovery tools are forwarded to the upstream hosted MCP server.
 * - `call_endpoint` is handled locally.
 */
export function registerTools(
  server: McpServer,
  mcpClient: McpClient | null,
  callEndpointDeps: CallEndpointDeps,
  options: RegisterToolsOptions = {},
): void {
  const { auditLogger } = options;
  const { config } = callEndpointDeps;
  const localToolDef = buildCallEndpointToolDefinition(config);

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!mcpClient) {
      // Discovery disabled — only the local call_endpoint tool is exposed.
      return { tools: [localToolDef] };
    }
    try {
      const upstream = await mcpClient.listTools();
      return { tools: [...upstream, localToolDef] };
    } catch (err) {
      throw new ProxyError("upstream", { cause: err });
    }
  });

  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const { name, arguments: args } = request.params;
      const start = Date.now();

      const context: RequestContext = {
        sessionId: extra.sessionId,
        requestId: extra.requestId,
        env: config.env,
      };

      const apiCall = apiCallDetails(name, args, config);
      await safeAudit(auditLogger, {
        timestamp: new Date(), tool: name, context, apiCall,
      });

      let result: CallToolResult;
      try {
        result = await executeTool(name, args, mcpClient, callEndpointDeps);
      } catch (err) {
        const message = safeErrorMessage(err, "upstream");
        await safeAudit(auditLogger, {
          timestamp: new Date(), tool: name, context, apiCall,
          result: { durationMs: Date.now() - start, error: message },
        });
        throw new Error(message, { cause: err });
      }

      await safeAudit(auditLogger, {
        timestamp: new Date(), tool: name, context, apiCall,
        result: resultDetails(result, Date.now() - start),
      });

      return result;
    },
  );
}

function extractErrorText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string | undefined {
  const first = result.content?.[0];
  if (first?.type === "text" && typeof first.text === "string") {
    return first.text;
  }
  return undefined;
}
