/**
 * Reusable HTTP session manager for the MCP proxy.
 *
 * This module is the public, dependency-friendly equivalent of the
 * session-handling logic in the CLI ({@link ./index.ts}). It is exported from
 * {@link ./api.ts} so internal consumers who embed the proxy in their own
 * Node HTTP server get the same safety guarantees as the CLI:
 *
 * - Maximum concurrent session cap (with pending-session race guard)
 * - Idle session TTL reaper
 * - Per-IP sliding-window rate limit on new sessions
 * - Shared upstream {@link TokenManager} across sessions
 * - Graceful shutdown
 *
 * Consumers are responsible for wiring `handleRequest` into a Node HTTP
 * server (or framework adapter) and deciding their own origin / auth policy.
 * {@link createLoopbackOriginCheck} and {@link createLoopbackHostCheck} are
 * provided for the common case.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type ProxyHandle, type ProxyOptions } from "./server.js";
import { getConfig } from "./config/config.js";
import { TokenManager } from "./auth/token-manager.js";
import { safeErrorMessage } from "./errors.js";

export interface HttpSessionHandlerOptions {
  /** Maximum concurrent sessions before new connections receive 503. */
  maxSessions?: number;
  /** Idle session TTL in milliseconds. In-flight POST requests are never reaped. */
  sessionTtlMs?: number;
  /** Maximum new-session creations per IP per {@link rateLimitWindowMs}. */
  rateLimitPerIp?: number;
  /** Sliding-window duration (ms) for the per-IP session creation rate limit. */
  rateLimitWindowMs?: number;
  /**
   * When true, the handler reads `X-Forwarded-For` to determine client IP.
   * Only enable this when the proxy runs behind a trusted reverse proxy that
   * sanitises XFF, otherwise clients can spoof the rate-limit key.
   */
  trustProxy?: boolean;
  /**
   * Options passed to {@link createServer} for each new session (e.g. a custom
   * audit logger). `tokenManager` is ignored — the handler always shares one.
   */
  proxyOptions?: Omit<ProxyOptions, "tokenManager">;
  /**
   * Optional pre-built upstream token manager. If omitted, the handler
   * constructs one from environment configuration when sandbox/live tiers are
   * configured. The handler owns the lifecycle of any token manager it builds.
   */
  tokenManager?: TokenManager;
}

export interface HttpSessionHandler {
  /** Wire this into your Node HTTP server's request callback. */
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Close all sessions, the shared token manager (if owned), and stop the reaper. */
  closeAll(): Promise<void>;
  /** Number of currently active sessions. Useful for tests and health checks. */
  readonly activeSessionCount: number;
}

interface SessionEntry {
  handle: Promise<ProxyHandle>;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  activeRequests: number;
  closed: boolean;
  connecting?: Promise<void>;
  close(): Promise<void>;
}

async function closeSessionResources(session: SessionEntry): Promise<void> {
  await session.transport.close().catch((err) =>
    console.error("[session] transport close error:", safeErrorMessage(err, "internal")),
  );
  await session.connecting?.catch((err) =>
    console.error("[session] connect error during close:", safeErrorMessage(err, "internal")),
  );
  await session.handle.then((handle) => handle.close()).catch((err) =>
    console.error("[session] close error:", safeErrorMessage(err, "internal")),
  );
}

const DEFAULTS = {
  maxSessions: 100,
  sessionTtlMs: 30 * 60 * 1000,
  rateLimitPerIp: 10,
  rateLimitWindowMs: 60_000,
} as const;

/**
 * Build an HTTP session handler. The returned object multiplexes MCP sessions
 * over a single Node HTTP endpoint with the same protections used by the CLI.
 */
export function createHttpSessionHandler(
  options: HttpSessionHandlerOptions = {},
): HttpSessionHandler {
  const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULTS.sessionTtlMs;
  const rateLimitPerIp = options.rateLimitPerIp ?? DEFAULTS.rateLimitPerIp;
  const rateLimitWindowMs =
    options.rateLimitWindowMs ?? DEFAULTS.rateLimitWindowMs;
  const trustProxy = options.trustProxy ?? false;
  const proxyOptions = options.proxyOptions ?? {};

  // Share a single TokenManager across all sessions: mTLS dispatchers are
  // expensive to construct and access tokens are safe to share per scope.
  let sharedTokenManager: TokenManager | undefined = options.tokenManager;
  let ownsTokenManager = false;
  if (!sharedTokenManager) {
    const config = proxyOptions.config ?? getConfig();
    if (config.sandbox || config.live) {
      sharedTokenManager = new TokenManager({ config });
      ownsTokenManager = true;
    }
  }

  const sessions = new Map<string, SessionEntry>();
  const connections = new Set<SessionEntry>();
  const ipCreationLog = new Map<string, number[]>();
  let reservedSessions = 0;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const createSession = (): SessionEntry => {
    let closePromise: Promise<void> | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (session.closed) return;
        sessions.set(id, session);
        console.error(`[session] created ${id} (active: ${sessions.size})`);
      },
    });
    const session: SessionEntry = {
      handle: createServer({
        ...proxyOptions,
        ...(sharedTokenManager ? { tokenManager: sharedTokenManager } : {}),
      }),
      transport,
      lastActivity: Date.now(),
      activeRequests: 1,
      closed: false,
      close() {
        if (!closePromise) {
          session.closed = true;
          reservedSessions--;
          const id = transport.sessionId;
          if (id && sessions.delete(id)) {
            console.error(`[session] closed ${id} (active: ${sessions.size})`);
          }
          // Defer cleanup so an SDK onclose callback reuses the same promise.
          closePromise = Promise.resolve()
            .then(() => closeSessionResources(session))
            .finally(() => connections.delete(session));
        }
        return closePromise;
      },
    };
    reservedSessions++;
    connections.add(session);
    transport.onclose = () => {
      void session.close();
    };
    return session;
  };

  const getClientIp = (req: IncomingMessage): string => {
    if (trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string") {
        return forwarded.split(",")[0].trim();
      }
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const checkRateLimit = (ip: string): boolean => {
    const now = Date.now();
    const timestamps = ipCreationLog.get(ip) ?? [];
    const recent = timestamps.filter((t) => now - t < rateLimitWindowMs);
    if (recent.length >= rateLimitPerIp) {
      ipCreationLog.set(ip, recent);
      return false;
    }
    recent.push(now);
    ipCreationLog.set(ip, recent);
    return true;
  };

  const reapIdleSessions = (): void => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.activeRequests === 0 && now - session.lastActivity > sessionTtlMs) {
        console.error(`[session] reaping idle session ${id}`);
        void session.close();
      }
    }
    for (const [ip, timestamps] of ipCreationLog) {
      const recent = timestamps.filter((t) => now - t < rateLimitWindowMs);
      if (recent.length === 0) {
        ipCreationLog.delete(ip);
      } else {
        ipCreationLog.set(ip, recent);
      }
    }
  };

  const reaperInterval = setInterval(reapIdleSessions, 60_000);
  reaperInterval.unref();

  const handleNewSession = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const session = createSession();
    const onDisconnect = (): void => {
      if (!res.writableFinished) void session.close();
    };
    const onRequestClose = (): void => {
      if (!req.complete) onDisconnect();
    };
    req.once("close", onRequestClose);
    res.once("close", onDisconnect);
    if ((req.destroyed && !req.complete) || res.destroyed) void session.close();

    try {
      const handle = await session.handle;
      if (!session.closed) {
        session.connecting = handle.server.connect(session.transport);
        await session.connecting;
      }
      if (session.closed) {
        if (!res.destroyed && !res.headersSent) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session initialization was cancelled. Try again later." }));
        }
        return;
      }
      await session.transport.handleRequest(req, res);
    } catch (err) {
      await session.close();
      throw err;
    } finally {
      req.off("close", onRequestClose);
      res.off("close", onDisconnect);
      session.activeRequests--;
      session.lastActivity = Date.now();
      if (!session.transport.sessionId || session.closed) await session.close();
    }
  };

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (shuttingDown) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "The proxy is shutting down." }));
      return;
    }
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session — route to its transport
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      const isPost = req.method === "POST";
      if (isPost) session.activeRequests++;
      session.lastActivity = Date.now();
      try {
        await session.transport.handleRequest(req, res);
      } finally {
        if (isPost) session.activeRequests--;
        session.lastActivity = Date.now();
      }
      return;
    }

    // Reject unknown session IDs
    if (sessionId) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    // Guard: max sessions cap (includes pending creations to prevent race)
    if (reservedSessions >= maxSessions) {
      console.error(
        `[session] rejected: max sessions reached (${maxSessions})`,
      );
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Too many active sessions. Try again later.",
        }),
      );
      return;
    }

    // Guard: per-IP rate limit
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp)) {
      console.error(
        `[session] rate-limited IP ${clientIp} (limit: ${rateLimitPerIp}/${rateLimitWindowMs}ms)`,
      );
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Rate limit exceeded for session creation. Try again later.",
        }),
      );
      return;
    }

    await handleNewSession(req, res);
  };

  const closeAll = (): Promise<void> => {
    shuttingDown = true;
    clearInterval(reaperInterval);
    shutdownPromise ??= Promise.all([...connections].map((session) => session.close()))
      .then(async () => {
        if (ownsTokenManager && sharedTokenManager) {
          await sharedTokenManager.close();
        }
      });
    return shutdownPromise;
  };

  return {
    handleRequest,
    closeAll,
    get activeSessionCount() {
      return sessions.size;
    },
  };
}

export interface LoopbackOriginCheckOptions {
  /** Port the HTTP server listens on. Used to enforce same-origin loopback. */
  port: number;
}

/**
 * DNS-rebinding protection helper. Returns a predicate that accepts:
 * - Requests with no `Origin` header (typical for non-browser MCP clients)
 * - Requests whose `Origin` is a loopback host on the configured port
 *
 * Use this in your HTTP server before dispatching to `handleRequest`.
 */
export function createLoopbackOriginCheck(
  options: LoopbackOriginCheckOptions,
): (origin: string | undefined) => boolean {
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const expectedPort = String(options.port);
  return (origin) => {
    if (!origin) return true;
    try {
      const u = new URL(origin);
      if (!loopbackHosts.has(u.hostname)) return false;
      return u.port === expectedPort;
    } catch {
      return false;
    }
  };
}

export interface LoopbackHostCheckOptions {
  /** Port the HTTP server listens on. */
  port: number;
}

const LOOPBACK_HOST_NAMES = ["localhost", "127.0.0.1", "[::1]"];

/**
 * DNS-rebinding protection helper for the `Host` header. A rebound page keeps
 * the attacker's host name in `Host`, also for requests without an `Origin`
 * (which {@link createLoopbackOriginCheck} accepts). Returns a predicate that
 * accepts only a loopback host name on the configured port; a request without
 * a `Host` header is rejected.
 *
 * Use it only when the server listens on a loopback address: other addresses
 * are reached under host names this check cannot know.
 */
export function createLoopbackHostCheck(
  options: LoopbackHostCheckOptions,
): (host: string | undefined) => boolean {
  const allowed = new Set(LOOPBACK_HOST_NAMES.map((name) => `${name}:${options.port}`));
  // A Host header leaves out the default port of the scheme.
  if (options.port === 80) {
    for (const name of LOOPBACK_HOST_NAMES) allowed.add(name);
  }
  return (host) => host !== undefined && allowed.has(host.toLowerCase());
}
