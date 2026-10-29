import { ProxyError } from "./errors.js";
import { createLoopbackHostCheck } from "./http-transport.js";

export interface HttpListenOptions {
  port: number;
  host: string;
}

const DEFAULT_PORT = 3001;
// Loopback by default. Customers exposing the proxy on a network should run it
// behind their own reverse proxy / auth wrapper rather than binding it directly.
const DEFAULT_HOST = "127.0.0.1";

/** The value of `--name <value>` or `--name=<value>`, or undefined when the flag is absent. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return undefined;
  const value =
    argv[index] === name ? argv[index + 1] : argv[index].slice(name.length + 1);
  if (!value || value.startsWith("--")) {
    throw new ProxyError("configuration", {
      hint: `${name} needs a value, e.g. ${name} ${name === "--port" ? DEFAULT_PORT : DEFAULT_HOST}`,
    });
  }
  return value;
}

/** The listener of `--transport http`, from `--port` and `--host`. */
export function parseHttpListenOptions(argv: readonly string[]): HttpListenOptions {
  const rawPort = flagValue(argv, "--port");
  let port = DEFAULT_PORT;
  if (rawPort !== undefined) port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyError("configuration", {
      hint: "Invalid --port. Must be an integer between 1 and 65535.",
    });
  }
  return { port, host: flagValue(argv, "--host") ?? DEFAULT_HOST };
}

const LOOPBACK_LISTEN_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Whether `--host` binds a loopback address, the only case where requests can be held to loopback host names. */
export function isLoopbackListenHost(host: string): boolean {
  return LOOPBACK_LISTEN_HOSTS.has(host.toLowerCase());
}

/**
 * The `Host` header check for the CLI listener. Other addresses are reached
 * under host names that cannot be known here (containers, WSL, reverse
 * proxies), so there it accepts everything.
 */
export function createListenerHostCheck(
  host: string,
  port: number,
): (hostHeader: string | undefined) => boolean {
  return isLoopbackListenHost(host) ? createLoopbackHostCheck({ port }) : () => true;
}
