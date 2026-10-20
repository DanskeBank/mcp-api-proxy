import fs from "node:fs";
import { Agent, fetch as undiciFetch, type RequestInit } from "undici";

/**
 * Build a `fetch`-compatible function that adds the given CA bundle to the
 * trusted CA list for outbound requests, via an undici dispatcher.
 *
 * Used by the MCP client (talking to the hosted MCP server over a private CA)
 * and by the API executor (talking to API Connect endpoints).
 */
export function buildFetchWithCa(caPath: string): typeof fetch {
  const ca = fs.readFileSync(caPath);
  const dispatcher = new Agent({ connect: { ca } });
  // undici's RequestInit is a structural superset of the global RequestInit
  // for our purposes. Cast at the boundary so callers see the WHATWG type.
  const wrapped: typeof fetch = (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as RequestInit | undefined),
      dispatcher,
    }) as unknown as ReturnType<typeof fetch>;
  return wrapped;
}
