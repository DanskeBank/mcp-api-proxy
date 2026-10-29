import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, type Config } from "./config/config.js";
import { McpClient } from "./clients/mcp-client.js";
import { isKeyRefusal } from "./clients/key-refusal.js";
import { ApicExecutor } from "./clients/apic-executor.js";
import { TokenManager } from "./auth/token-manager.js";
import { registerTools, discoveryUnavailableMessage } from "./tools/discovery.js";
import { getDefaultTier, getUsableTiers } from "./tools/call-endpoint.js";
import {
  ConsoleAuditLogger,
  redactUrl,
  type AuditLogger,
} from "./middleware/audit-logger.js";
import { ProxyError, safeErrorMessage } from "./errors.js";
import { PACKAGE_VERSION } from "./version.js";

export interface ProxyOptions {
  /** Custom audit logger implementation. Defaults to ConsoleAuditLogger (stderr JSON). */
  auditLogger?: AuditLogger;
  /** Shared TokenManager — when provided, the server will NOT create or close its own. */
  tokenManager?: TokenManager;
  /**
   * Programmatic configuration override. When provided, environment variables
   * are ignored entirely. Useful for embedding the proxy in a larger process
   * that manages its own configuration source (vault, config service, tests).
   */
  config?: Config;
}

export interface ProxyHandle {
  server: McpServer;
  /** Null when the upstream MCP server is unreachable after retries or refused the API key. */
  mcpClient: McpClient | null;
  close(): Promise<void>;
}

export function logStartup(config: Config): void {
  const tiers = getUsableTiers(config);
  const defaultTier = getDefaultTier(config);
  console.error(
    `[proxy] env=${config.env} upstream=${redactUrl(config.mcpServerUrl).urlPath}` +
      (config.extraCaCertPath ? " ca=on" : "") +
      (config.mcpServerApiKey ? " mcp-api-key=on" : " mcp-api-key=missing") +
      (tiers.includes("sandbox") ? " sandbox=on" : "") +
      (tiers.includes("live") ? " live=on" : "") +
      ` enabled-tiers=${tiers.join(",") || "none"} default-tier=${defaultTier}` +
      (tiers.includes(defaultTier) ? "" : " (unavailable)") +
      (defaultTier === "live" ? " (default uses real data, GET only)" : ""),
  );
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

interface UpstreamConnection {
  mcpClient: McpClient | null;
  hostedInstructions: string;
  /** Why hosted discovery is unavailable, when the proxy can explain it to the user and the agent. */
  upstreamProblem?: ProxyError;
}

/** Connects to the upstream MCP server, retrying a few times before giving up. */
async function connectUpstream(config: Config): Promise<UpstreamConnection> {
  let upstreamProblem: ProxyError | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const mcpClient = new McpClient(config.mcpServerUrl, {
      extraCaCertPath: config.extraCaCertPath,
      apiKey: config.mcpServerApiKey,
    });
    try {
      await mcpClient.connect();
      return { mcpClient, hostedInstructions: mcpClient.getServerInstructions() };
    } catch (err) {
      await mcpClient.close().catch(() => {});
      if (isKeyRefusal(err)) {
        console.error(
          "[proxy] upstream connect failed, not retrying — discovery tools will be unavailable",
          err.message,
        );
        return { mcpClient: null, hostedInstructions: "", upstreamProblem: err };
      }
      upstreamProblem = err instanceof ProxyError ? err : undefined;
      if (attempt < MAX_RETRIES) {
        console.error(
          `[proxy] upstream connect attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${RETRY_DELAY_MS}ms…`,
          safeErrorMessage(err, "upstream"),
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(
          `[proxy] upstream connect failed after ${MAX_RETRIES} attempts — discovery tools will be unavailable`,
          safeErrorMessage(err, "upstream"),
        );
      }
    }
  }
  return { mcpClient: null, hostedInstructions: "", upstreamProblem };
}

export async function createServer(
  options: ProxyOptions = {},
): Promise<ProxyHandle> {
  const {
    auditLogger = new ConsoleAuditLogger(),
    tokenManager: sharedTokenManager,
    config: configOverride,
  } = options;

  const config = configOverride ?? getConfig();
  logStartup(config);

  const { mcpClient, hostedInstructions, upstreamProblem } = await connectUpstream(config);

  // Use shared TokenManager if provided; otherwise create a per-session one.
  const ownsTokenManager = !sharedTokenManager;
  const tokenManager =
    sharedTokenManager ??
    (config.sandbox || config.live ? new TokenManager({ config }) : undefined);

  const server = new McpServer(
    { name: "danske-api-proxy", version: PACKAGE_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        hostedInstructions ||
        (upstreamProblem ? discoveryUnavailableMessage(upstreamProblem) : undefined),
    },
  );

  registerTools(
    server,
    mcpClient,
    {
      config,
      apicExecutor: new ApicExecutor({
        extraCaCertPath: config.extraCaCertPath,
        ...(tokenManager ? { tokenManager } : {}),
      }),
    },
    { auditLogger, upstreamProblem },
  );

  return {
    server,
    mcpClient,
    async close() {
      if (mcpClient) await mcpClient.close();
      if (ownsTokenManager && tokenManager) await tokenManager.close();
      await server.close();
    },
  };
}
