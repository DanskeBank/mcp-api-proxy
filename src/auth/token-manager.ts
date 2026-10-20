import { fetch as undiciFetch, type Dispatcher } from "undici";
import { z } from "zod";
import type { Config } from "../config/config.js";
import type { EnvironmentAuth, Tier } from "../types/index.js";
import { buildMtlsAgent } from "./mtls.js";
import { ProxyError } from "../errors.js";

export type AuthTier = Exclude<Tier, "mock">;

interface CachedToken {
  accessToken: string;
  /** Epoch ms at which we should consider the token stale and refresh. */
  refreshAt: number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().refine((value) => value.trim().length > 0),
  expires_in: z.number().finite().positive(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer").optional(),
});

async function parseTokenResponse(
  response: { json(): Promise<unknown> },
  tier: AuthTier,
): Promise<z.infer<typeof tokenResponseSchema>> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ProxyError("auth", {
      tier,
      hint: "Invalid token response JSON. Check the token URL settings.",
    });
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] ?? "response"))];
    throw new ProxyError("auth", {
      tier,
      hint: `Invalid token response fields: ${fields.join(", ")}. Check the OAuth token endpoint.`,
    });
  }
  return parsed.data;
}

export type AgentFactory = (
  auth: EnvironmentAuth,
  caPath?: string,
) => Dispatcher;

export interface TokenManagerOptions {
  config: Config;
  /** Overridable for tests. */
  fetchImpl?: typeof undiciFetch;
  /** Overridable for tests. */
  agentFactory?: AgentFactory;
  /** Overridable for tests (epoch ms). */
  now?: () => number;
}

/** Refresh the token this many ms before its declared expiry. */
const REFRESH_LEAD_MS = 60_000;

/**
 * Per-tier OAuth2 client_credentials token cache with single-flight de-dup
 * and 401 invalidation. Owns one mTLS Dispatcher per tier — exposed via
 * `getDispatcher` so the executor can reuse the same TLS connection pool
 * for the actual API calls.
 */
export class TokenManager {
  private readonly config: Config;
  private readonly fetchImpl: typeof undiciFetch;
  private readonly agentFactory: AgentFactory;
  private readonly now: () => number;

  private readonly tokens = new Map<AuthTier, CachedToken>();
  private readonly inflight = new Map<AuthTier, Promise<string>>();
  private readonly agents = new Map<AuthTier, Dispatcher>();

  constructor(opts: TokenManagerOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? undiciFetch;
    this.agentFactory = opts.agentFactory ?? buildMtlsAgent;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Returns a fresh-or-cached access token for the given tier. */
  async getToken(tier: AuthTier): Promise<string> {
    const cached = this.tokens.get(tier);
    if (cached && cached.refreshAt > this.now()) {
      return cached.accessToken;
    }
    const existing = this.inflight.get(tier);
    if (existing) return existing;

    const promise = this.fetchToken(tier).finally(() => {
      this.inflight.delete(tier);
    });
    this.inflight.set(tier, promise);
    return promise;
  }

  /** Drop the cached token for `tier` (e.g. after a 401). */
  invalidate(tier: AuthTier): void {
    this.tokens.delete(tier);
  }

  /** Returns the cached mTLS dispatcher for `tier`, building it on first use. */
  getDispatcher(tier: AuthTier): Dispatcher {
    let agent = this.agents.get(tier);
    if (!agent) {
      const auth = this.requireAuth(tier);
      // Sandbox and production Premium API hosts both present publicly
      // trusted certs, so extraCaCertPath is unset there and undici.Agent
      // falls back to Node's default trust store. A custom non-prod tier's
      // equivalents of these hosts may be signed by a private CA instead —
      // point MCP_SERVER_CA_CERT at it to trust them (swap the file when
      // it's rotated, no code change needed).
      agent = this.agentFactory(auth, this.config.extraCaCertPath);
      this.agents.set(tier, agent);
    }
    return agent;
  }

  /** Best-effort cleanup of cached dispatchers. */
  async close(): Promise<void> {
    const tasks: Array<Promise<unknown>> = [];
    for (const agent of this.agents.values()) {
      tasks.push(Promise.resolve(agent.close()).catch(() => {}));
    }
    this.agents.clear();
    this.tokens.clear();
    await Promise.allSettled(tasks);
  }

  private requireAuth(tier: AuthTier): EnvironmentAuth {
    const auth = tier === "sandbox" ? this.config.sandbox : this.config.live;
    if (!auth) {
      throw new Error(
        `No client credentials configured for ${tier} tier. ` +
          "Set CLIENT_ID + CLIENT_CERT_PEM + CLIENT_KEY_PEM.",
      );
    }
    return auth;
  }

  private async fetchToken(tier: AuthTier): Promise<string> {
    try {
      return await this.requestToken(tier);
    } catch (err) {
      if (err instanceof ProxyError) throw err;
      throw new ProxyError("auth", { tier, cause: err });
    }
  }

  private async requestToken(tier: AuthTier): Promise<string> {
    const auth = this.requireAuth(tier);
    const clientId = this.config.clientId;
    if (!clientId) {
      throw new Error("CLIENT_ID is required to mint OAuth2 tokens.");
    }
    const dispatcher = this.getDispatcher(tier);

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: this.config.tokenScope,
      client_id: clientId,
    });

    const response = await this.fetchImpl(auth.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      dispatcher,
      // A redirect would resend the client id and certificate elsewhere; a 3xx fails below instead.
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProxyError("auth", { tier, statusCode: response.status });
    }
    const json = await parseTokenResponse(response, tier);

    // Use at most REFRESH_LEAD_MS before expiry, but never more than half the
    // token lifetime — prevents infinite-refetch when tokens are short-lived.
    const lifetimeMs = json.expires_in * 1000;
    const lead = Math.min(REFRESH_LEAD_MS, Math.floor(lifetimeMs / 2));
    const refreshAt = this.now() + lifetimeMs - lead;
    if (!Number.isFinite(refreshAt)) {
      throw new ProxyError("auth", {
        tier,
        hint: "Invalid token response field: expires_in. The lifetime must produce a finite expiry.",
      });
    }
    this.tokens.set(tier, { accessToken: json.access_token, refreshAt });
    return json.access_token;
  }
}
