/**
 * Public API for @danskebank/mcp-api-proxy.
 *
 * Consumers who want to customise the proxy (e.g. custom audit logging)
 * import from this entry point:
 *
 *   import { createServer, ConsoleAuditLogger } from "@danskebank/mcp-api-proxy";
 */

export { createServer } from "./server.js";
export type { ProxyHandle, ProxyOptions } from "./server.js";

export { getConfig } from "./config/config.js";
export type { Config, Environment, ApiHosts } from "./config/config.js";

export {
  createHttpSessionHandler,
  createLoopbackOriginCheck,
} from "./http-transport.js";
export type {
  HttpSessionHandler,
  HttpSessionHandlerOptions,
  LoopbackOriginCheckOptions,
} from "./http-transport.js";

export { ConsoleAuditLogger } from "./middleware/audit-logger.js";
export type {
  AuditLogger,
  AuditEvent,
  RequestContext,
  ApiCallDetails,
} from "./middleware/audit-logger.js";
