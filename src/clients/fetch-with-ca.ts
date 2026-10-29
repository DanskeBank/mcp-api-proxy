import { Agent, fetch as undiciFetch, type RequestInit } from "undici";
import { readCaBundle } from "../ca-bundle.js";

/**
 * Build a `fetch`-compatible function that adds the given CA bundle to the
 * trusted CA list for outbound requests, via an undici dispatcher.
 *
 * Used by the MCP client and by the API executor (talking to API Connect
 * endpoints).
 */
export function buildFetchWithCa(caPath: string): typeof fetch {
  const dispatcher = new Agent({ connect: { ca: readCaBundle(caPath) } });
  // undici's request types are structurally compatible with the global ones
  // for our purposes. Cast the arguments at the boundary so callers see the
  // WHATWG types.
  const wrapped: typeof fetch = (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as RequestInit | undefined),
      dispatcher,
    });
  return wrapped;
}
