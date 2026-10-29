#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, logStartup } from "./server.js";
import { ProxyError, safeErrorMessage } from "./errors.js";
import { getConfig, loadSettingsFile, warnRemovedSettings } from "./config/config.js";
import {
  createListenerHostCheck,
  isLoopbackListenHost,
  parseHttpListenOptions,
} from "./cli-options.js";
import {
  createHttpSessionHandler,
  createLoopbackOriginCheck,
} from "./http-transport.js";

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
  warnRemovedSettings();
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
    const { port: httpPort, host: httpHost } = parseHttpListenOptions(process.argv);
    const config = getConfig();
    const sessionHandler = createHttpSessionHandler({ proxyOptions: { config } });
    logStartup(config);

    // DNS-rebinding protection. Browsers send Origin on cross-origin fetches;
    // we only accept same-origin loopback requests. Non-browser clients
    // (VS Code, Claude Desktop, curl) typically omit Origin entirely.
    const isAllowedOrigin = createLoopbackOriginCheck({ port: httpPort });
    // A rebound page keeps the attacker's host name in `Host`, and its
    // same-origin requests carry no `Origin`, so `Host` is checked as well
    // (on a loopback listener only).
    const isAllowedHost = createListenerHostCheck(httpHost, httpPort);
    if (!isLoopbackListenHost(httpHost)) {
      console.error(
        "[http] Host header check skipped: --host is not a loopback address (127.0.0.1, ::1 or localhost).",
      );
    }

    const httpServer = createHttpServer((req, res) => {
      if (!isAllowedHost(req.headers.host)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden host" }));
        return;
      }
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
      console.error("[http] [configuration] Cannot start the HTTP listener. Check --host and --port.");
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
