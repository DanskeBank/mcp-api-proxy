import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import type { EnvironmentAuth } from "../types/index.js";
import { ProxyError } from "../errors.js";
import {
  DEFAULT_TOKEN_SCOPE,
  extraProfiles,
  hasExtraProfiles,
  resolveProfile,
  supportedEnvs,
  type EnvProfile,
  type ExtraProfiles,
  type TierEndpoints,
} from "./profiles.js";

// Names a profile in profiles.ts. Kept as a named alias (not inlined `string`)
// for public API readability.
export type Environment = string; // NOSONAR: intentional alias, not redundant

export interface ApiHosts {
  /** Mock host — no auth required, all methods allowed. Always present. */
  mock: string;
  /** Sandbox host — auth required, all methods allowed. Only present where the environment has a sandbox tier that can authenticate. */
  sandbox?: string;
  /** Live host — auth required, GET only. Present where the environment has a live tier that can authenticate. */
  live?: string;
}

export interface Config {
  /** Logical environment selector */
  env: Environment;
  /** Hosted MCP server URL for discovery tool forwarding */
  mcpServerUrl: string;
  /** Optional path to extra CA bundle (PEM) for the upstream MCP server */
  extraCaCertPath?: string;
  /** Optional API key sent as `X-API-Key` when required by the upstream MCP server */
  mcpServerApiKey?: string;
  /** API Connect hostnames for the active environment */
  apiHosts: ApiHosts;
  /** OAuth2 scope: a space-delimited list of the Premium API products (default "accounts payments", narrowed with TOKEN_SCOPE) */
  tokenScope: string;
  /** OAuth2 client ID from Developer Portal. Required for any auth tier. */
  clientId?: string;
  /** Sandbox-tier auth (set when CLIENT_CERT_PEM + CLIENT_KEY_PEM are provided and env has a sandbox tier) */
  sandbox?: EnvironmentAuth;
  /** Live-tier auth (set when CLIENT_CERT_PEM + CLIENT_KEY_PEM are provided and env has a live tier) */
  live?: EnvironmentAuth;
}

// Not --env-file: Node intercepts that flag anywhere in argv, even after the script name.
const SETTINGS_FILE_FLAG = "--settings-file";

/** The path given with `--settings-file <path>` or `--settings-file=<path>`, if any. */
function settingsFileArg(argv: readonly string[]): string | undefined {
  const index = argv.findIndex(
    (arg) =>
      arg === SETTINGS_FILE_FLAG || arg.startsWith(`${SETTINGS_FILE_FLAG}=`),
  );
  if (index === -1) return undefined;
  const value =
    argv[index] === SETTINGS_FILE_FLAG
      ? argv[index + 1]
      : argv[index].slice(SETTINGS_FILE_FLAG.length + 1);
  if (!value || value.startsWith("--")) {
    throw new ProxyError("configuration", {
      hint: `${SETTINGS_FILE_FLAG} needs a path, e.g. ${SETTINGS_FILE_FLAG} /path/to/danske-proxy.env`,
    });
  }
  return value;
}

/** An unreadable `.env` (for example a symlink loop) is not worth stopping the proxy for. */
function hasWorkspaceDotenv(cwd: string): boolean {
  try {
    return fs.statSync(path.join(cwd, ".env")).isFile();
  } catch {
    return false;
  }
}

/**
 * Loads the file given with `--settings-file` into `process.env` before
 * `getConfig` reads it. Variables that are already set win over the file.
 * Nothing is read implicitly: a `.env` in the working directory belongs to the
 * workspace the client launched the proxy from, not to the user. Returns the
 * path of the loaded file.
 */
export function loadSettingsFile(
  argv: readonly string[],
  cwd: string = process.cwd(),
): string | undefined {
  const requested = settingsFileArg(argv);
  if (!requested) {
    if (hasWorkspaceDotenv(cwd)) {
      console.error(
        "[proxy] the .env file in the working directory is not loaded. Pass --settings-file <path> to use it.",
      );
    }
    return undefined;
  }
  const file = path.resolve(cwd, requested.replace(/^~(?=$|[\\/])/, os.homedir()));

  let content: Buffer;
  try {
    content = fs.readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const codeSuffix = code ? ` (${code})` : "";
    throw new ProxyError("configuration", {
      hint: `Cannot read the settings file${codeSuffix}. Check the path after --settings-file and that the file is readable.`,
      cause: err,
    });
  }
  // dotenv's config() can print to stdout, which carries the stdio protocol; parse() never does.
  for (const [key, value] of Object.entries(parseDotenv(content))) {
    process.env[key] ??= value;
  }
  return file;
}

// Hosts and token endpoints now come from the environment profile, and
// the HTTP listener is set with --port and --host.
const REMOVED_SETTINGS = [
  "MCP_SERVER_URL",
  "MCP_API_HOST_MOCK",
  "MCP_API_HOST_SANDBOX",
  "MCP_API_HOST_LIVE",
  "SANDBOX_TOKEN_URL",
  "LIVE_TOKEN_URL",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "MCP_MAX_SESSIONS",
  "MCP_SESSION_TTL_MS",
  "MCP_RATE_LIMIT_PER_IP",
  "MCP_RATE_LIMIT_WINDOW_MS",
  "MCP_TRUST_PROXY",
] as const;

/** Names, never values, of settings that are set but no longer have any effect. */
export function warnRemovedSettings(extra: ExtraProfiles = extraProfiles): void {
  const ignored = REMOVED_SETTINGS.filter((name) => process.env[name] !== undefined);
  if (ignored.length > 0) {
    console.error(
      `[proxy] ignoring settings that are no longer supported: ${ignored.join(", ")}. ` +
        "Hosts and token endpoints are built into the package; use --port and --host for the HTTP listener.",
    );
  }
  const env = process.env.MCP_ENV;
  if (!hasExtraProfiles(extra) && env && env !== "prod" && env !== "production") {
    console.error("[proxy] MCP_ENV is ignored: this package supports production only.");
  }
}

function warnIncompleteAuth(profile: EnvProfile): void {
  const credentialNames = ["CLIENT_ID", "CLIENT_CERT_PEM", "CLIENT_KEY_PEM"] as const;
  const hasCredentials =
    credentialNames.some((name) => Boolean(process.env[name])) ||
    Boolean(process.env.CLIENT_KEY_PASSPHRASE);
  if (!hasCredentials) return;

  const tiers = (["sandbox", "live"] as const).filter((tier) => profile[tier]);
  if (tiers.length === 0) {
    console.error(
      "[proxy] authentication settings are unused: this environment has no sandbox or live tier.",
    );
    return;
  }

  const missing = credentialNames.filter((name) => !process.env[name]);
  for (const tier of tiers) {
    const label = tier === "sandbox" ? "Sandbox" : "Live";
    if (!profile[tier]?.tokenUrl) {
      console.error(
        `[proxy] ${tier} authentication is not available in this environment. ${label} calls are unavailable.`,
      );
    } else if (missing.length > 0) {
      console.error(
        `[proxy] incomplete ${tier} authentication: missing ${missing.join(", ")}. ${label} calls are unavailable.`,
      );
    }
  }

  // Private keys are normally encrypted, so sign-in is likely to fail without
  // the passphrase. Only a warning: an unencrypted key works without one.
  const canAuthenticate = tiers.some((tier) => profile[tier]?.tokenUrl);
  if (canAuthenticate && missing.length === 0 && !process.env.CLIENT_KEY_PASSPHRASE) {
    console.error(
      "[proxy] CLIENT_KEY_PASSPHRASE is not set. Authentication fails if your private key is encrypted, which is the usual case.",
    );
  }
}

/**
 * The scopes to request: `TOKEN_SCOPE` for a client registered for fewer
 * products than the default covers. It can only narrow what is requested; it
 * cannot redirect credentials. Blank counts as unset.
 */
function tokenScopeFromEnv(): string {
  const scopes = process.env.TOKEN_SCOPE?.split(/\s+/).filter(Boolean);
  return scopes?.length ? scopes.join(" ") : DEFAULT_TOKEN_SCOPE;
}

export function getConfig(): Config {
  return configFor(extraProfiles);
}

/** `getConfig` for a given set of extra profiles, so both kinds of build can be tested. */
export function configFor(extra: ExtraProfiles): Config {
  const resolved = resolveProfile(process.env.MCP_ENV, extra);
  if (!resolved) {
    throw new ProxyError("configuration", {
      hint: `Invalid MCP_ENV. Supported: ${supportedEnvs(extra).join(", ")}.`,
    });
  }
  const { env, profile } = resolved;

  warnIncompleteAuth(profile);

  const clientId = process.env.CLIENT_ID;
  // Single set of mTLS credentials shared by both sandbox and live tiers.
  const clientCert = process.env.CLIENT_CERT_PEM;
  const clientKey = process.env.CLIENT_KEY_PEM;
  const clientKeyPassphrase = process.env.CLIENT_KEY_PASSPHRASE;

  const credentials =
    clientId && clientCert && clientKey
      ? {
          certPath: clientCert,
          keyPath: clientKey,
          ...(clientKeyPassphrase ? { keyPassphrase: clientKeyPassphrase } : {}),
        }
      : undefined;
  const authFor = (tier?: TierEndpoints): EnvironmentAuth | undefined =>
    credentials && tier?.tokenUrl
      ? { ...credentials, tokenUrl: tier.tokenUrl }
      : undefined;
  const sandbox = authFor(profile.sandbox);
  const live = authFor(profile.live);

  return {
    env,
    mcpServerUrl: profile.mcpServerUrl,
    // Optional: trust an additional CA bundle.
    ...(process.env.MCP_SERVER_CA_CERT
      ? { extraCaCertPath: process.env.MCP_SERVER_CA_CERT }
      : {}),
    mcpServerApiKey: process.env.MCP_SERVER_API_KEY,
    // A tier without a token endpoint cannot authenticate, so its host is not offered.
    apiHosts: {
      mock: profile.mockHost,
      ...(profile.sandbox?.tokenUrl ? { sandbox: profile.sandbox.host } : {}),
      ...(profile.live?.tokenUrl ? { live: profile.live.host } : {}),
    },
    tokenScope: tokenScopeFromEnv(),
    clientId,
    ...(sandbox ? { sandbox } : {}),
    ...(live ? { live } : {}),
  };
}
