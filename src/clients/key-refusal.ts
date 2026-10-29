import { ProxyError } from "../errors.js";

// Every attempt with a refused key counts against the hosted server's limit for
// invalid keys. Remembering the refusal per process stops many HTTP sessions, or
// an agent calling tools in a loop, from sending the same key again. It expires
// so a key that is activated later, or a lifted rate limit, is picked up.
const REFUSAL_TTL_MS = 60_000;

interface Refusal {
  apiKey: string | undefined;
  problem: ProxyError;
  expiresAt: number;
}

const refusals = new Map<string, Refusal>();

/** True for errors that retrying cannot fix: the hosted server refused the API key. */
export function isKeyRefusal(err: unknown): err is ProxyError {
  return err instanceof ProxyError && (err.category === "auth" || err.category === "rate_limited");
}

export function recentKeyRefusal(
  serverUrl: string,
  apiKey: string | undefined,
): ProxyError | undefined {
  const refusal = refusals.get(serverUrl);
  if (!refusal) return undefined;
  if (refusal.expiresAt <= Date.now()) {
    refusals.delete(serverUrl);
    return undefined;
  }
  return refusal.apiKey === apiKey ? refusal.problem : undefined;
}

export function rememberKeyRefusal(
  serverUrl: string,
  apiKey: string | undefined,
  problem: ProxyError,
): void {
  refusals.set(serverUrl, { apiKey, problem, expiresAt: Date.now() + REFUSAL_TTL_MS });
}

export function resetKeyRefusals(): void {
  refusals.clear();
}
