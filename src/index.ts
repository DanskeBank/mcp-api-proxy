#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, logStartup } from "./server.js";
import { ProxyError, safeErrorMessage } from "./errors.js";
import { getConfig, loadSettingsFile } from "./config/config.js";
import {
  createHttpSessionHandler,
  createLoopbackOriginCheck,
} from "./http-transport.js";

function parsePort(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ProxyError("configuration", {
      hint: "Invalid MCP_HTTP_PORT. Must be an integer between 1 and 65535.",
    });
  }
  return n;
}

function parsePositiveInt(name: string, raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ProxyError("configuration", {
      hint: `Invalid ${name}. Must be a positive integer.`,
    });
  }
  return n;
}

const HTTP_PATH = "/mcp";

function parseTransport(): "stdio" | "http" {
  const idx = process.argv.indexOf("--transport");
  if (idx === -1) return "stdio";
  const val = process.argv[idx + 1];
  if (val !== "stdio" && val !== "http") {
    throw new ProxyError("configuration", {
      hint: "Unknown transport. Supported: stdio, http.",
    });
  }
  return val;
}

async function main(): Promise<void> {
  const settingsFile = loadSettingsFile(process.argv);
  if (settingsFile) console.error(`[proxy] settings loaded from ${settingsFile}`);
  const transport = parseTransport();

  if (transport === "stdio") {
    const handle = await createServer();

    const shutdown = async (signal: string): Promise<void> => {
      console.error(`Received ${signal}, shutting down...`);
      try {
        await handle.close();
      } catch (err) {
        console.error("Error during shutdown:", safeErrorMessage(err, "internal"));
      }
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    const stdio = new StdioServerTransport();
    await handle.server.connect(stdio);
    console.error("MCP proxy running on stdio");
  } else {
    const httpPort = parsePort(process.env.MCP_HTTP_PORT ?? "3001");
    // Bind to loopback by default. Customers exposing this on a network should
    // run behind their own reverse proxy / auth wrapper (see README "Custom Audit
    // Logger" section) rather than binding directly.
    const httpHost = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
    const sessionOptions = {
      maxSessions: parsePositiveInt(
        "MCP_MAX_SESSIONS",
        process.env.MCP_MAX_SESSIONS ?? "100",
      ),
      sessionTtlMs: parsePositiveInt(
        "MCP_SESSION_TTL_MS",
        process.env.MCP_SESSION_TTL_MS ?? String(30 * 60 * 1000),
      ),
      rateLimitPerIp: parsePositiveInt(
        "MCP_RATE_LIMIT_PER_IP",
        process.env.MCP_RATE_LIMIT_PER_IP ?? "10",
      ),
      rateLimitWindowMs: parsePositiveInt(
        "MCP_RATE_LIMIT_WINDOW_MS",
        process.env.MCP_RATE_LIMIT_WINDOW_MS ?? "60000",
      ),
      trustProxy:
        process.env.MCP_TRUST_PROXY === "1" ||
        process.env.MCP_TRUST_PROXY === "true",
    };
    const config = getConfig();
    const sessionHandler = createHttpSessionHandler({
      ...sessionOptions,
      proxyOptions: { config },
    });
    logStartup(config);

    // DNS-rebinding protection. Browsers send Origin on cross-origin fetches;
    // we only accept same-origin loopback requests. Non-browser clients
    // (VS Code, Claude Desktop, curl) typically omit Origin entirely.
    const isAllowedOrigin = createLoopbackOriginCheck({ port: httpPort });

    const httpServer = createHttpServer((req, res) => {
      if (!isAllowedOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden origin" }));
        return;
      }
      const url = req.url?.split("?")[0];
      if (url === HTTP_PATH) {
        sessionHandler.handleRequest(req, res).catch((err) => {
          console.error("[http] request error:", safeErrorMessage(err, "internal"));
          if (!res.headersSent) {
            res.writeHead(500).end("Internal server error");
          }
        });
      } else {
        res.writeHead(404).end("Not found");
      }
    });

    httpServer.on("error", () => {
      console.error("[http] [configuration] Cannot start the HTTP listener. Check MCP_HTTP_HOST and MCP_HTTP_PORT.");
      void sessionHandler.closeAll().finally(() => process.exit(1));
    });

    const shutdown = async (signal: string): Promise<void> => {
      console.error(`Received ${signal}, shutting down...`);
      const forceExit = setTimeout(() => {
        console.error("Shutdown timed out, forcing exit.");
        process.exit(1);
      }, 10_000).unref();
      try {
        httpServer.close();
        // Close all open connections (SSE streams, keep-alive) immediately
        (
          httpServer as { closeAllConnections?: () => void }
        ).closeAllConnections?.();
        await sessionHandler.closeAll();
      } catch (err) {
        console.error("Error during shutdown:", safeErrorMessage(err, "internal"));
      }
      clearTimeout(forceExit);
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    httpServer.listen(httpPort, httpHost, () => {
      console.error(
        `MCP proxy running on http://${httpHost}:${httpPort}${HTTP_PATH}`,
      );
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", safeErrorMessage(err, "configuration"));
  process.exit(1);
});
