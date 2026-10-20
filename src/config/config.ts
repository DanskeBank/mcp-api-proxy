import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import type { EnvironmentAuth } from "../types/index.js";
import { ProxyError } from "../errors.js";

// "prod" gets built-in hosts; any other value (including none) is treated
// as a custom non-prod tier and just needs MCP_SERVER_URL / MCP_API_HOST_*.
// Kept as a named alias (not inlined `string`) for public API readability.
export type Environment = string; // NOSONAR: intentional alias, not redundant

export interface ApiHosts {
  /** Mock host — no auth required, all methods allowed. Always present. */
  mock: string;
  /** Sandbox host — auth required, all methods allowed. Only present in MCP_ENV=prod. */
  sandbox?: string;
  /** Live host — auth required, GET only. Present in prod, or any non-prod tier that sets MCP_API_HOST_LIVE. */
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
  /** OAuth2 scope — selects the Premium API product (e.g. "accounts") */
  tokenScope: string;
  /** OAuth2 client ID from Developer Portal. Required for any auth tier. */
  clientId?: string;
  /** Sandbox-tier auth (set when CLIENT_CERT_PEM + CLIENT_KEY_PEM are provided and env has a sandbox tier) */
  sandbox?: EnvironmentAuth;
  /** Live-tier auth (set when CLIENT_CERT_PEM + CLIENT_KEY_PEM are provided and env has a live tier) */
  live?: EnvironmentAuth;
}

interface EnvDefaults {
  mcpServerUrl: string;
  extraCaCertPath?: string;
  apiHosts: ApiHosts;
  /** OAuth2 token endpoint for the sandbox API tier (only when sandbox host exists). */
  sandboxTokenUrl?: string;
  /** OAuth2 token endpoint for the live API tier. */
  liveTokenUrl?: string;
}

// Only "prod" has built-in hosts. Any other MCP_ENV value is a custom,
// non-prod tier — set MCP_SERVER_URL and MCP_API_HOST_* (plus
// LIVE_TOKEN_URL) to point it at your own environment.
const PROD_DEFAULTS: EnvDefaults = {
  mcpServerUrl: "https://mcp.danskebank.com/mcp",
  // Production uses a publicly trusted certificate — no extra CA needed.
  apiHosts: {
    mock: "mock-api.danskebank.com",
    sandbox: "sandbox-api.danskebank.com",
    live: "api.danskebank.com",
  },
  // All Premium APIs except the Payment Collection API, which uses .../fi/business/oauth2/token.
  sandboxTokenUrl:
    "https://sandbox-api.danskebank.com/sandbox-corporate/api/dk/business/oauth2/token",
  liveTokenUrl: "https://api.danskebank.com/corporate/api/dk/business/oauth2/token",
};

const NON_PROD_DEFAULTS: EnvDefaults = {
  mcpServerUrl: "",
  // No bundled CA — a custom non-prod tier's TLS trust for API Connect must
  // be supplied explicitly via MCP_SERVER_CA_CERT, same as CLIENT_CERT_PEM.
  apiHosts: { mock: "" },
};

function parseEnv(value: string | undefined): Environment {
  if (value === "prod" || value === "production") return "prod";
  return value || "test";
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

/**
 * Loads settings into `process.env` before `getConfig` reads them: the file
 * given with `--settings-file`, otherwise `.env` in `cwd` when it can be read.
 * Variables that are already set win over the file. Returns the path of the
 * loaded file.
 */
export function loadSettingsFile(
  argv: readonly string[],
  cwd: string = process.cwd(),
): string | undefined {
  const requested = settingsFileArg(argv);
  const file = requested
    ? path.resolve(cwd, requested.replace(/^~(?=$|[\\/])/, os.homedir()))
    : path.join(cwd, ".env");

  let content: Buffer;
  try {
    content = fs.readFileSync(file);
  } catch (err) {
    // Only a file the user asked for is required; a missing or unreadable .env (or a .env folder) is skipped.
    if (!requested) return undefined;
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

function warnIncompleteAuth(
  apiHosts: ApiHosts,
  tokenUrls: { sandbox?: string; live?: string },
): void {
  const credentialNames = ["CLIENT_ID", "CLIENT_CERT_PEM", "CLIENT_KEY_PEM"] as const;
  const hasCredentials =
    credentialNames.some((name) => Boolean(process.env[name])) ||
    Boolean(process.env.CLIENT_KEY_PASSPHRASE);

  if (hasCredentials && !apiHosts.sandbox && !apiHosts.live) {
    console.error(
      "[proxy] authentication settings are unused: configure MCP_API_HOST_SANDBOX or MCP_API_HOST_LIVE and its token URL.",
    );
  }

  for (const tier of ["sandbox", "live"] as const) {
    const tokenName = `${tier.toUpperCase()}_TOKEN_URL`;
    if (!process.env[tokenName] && (!hasCredentials || !apiHosts[tier])) continue;

    const missing: string[] = credentialNames.filter((name) => !process.env[name]);
    if (!apiHosts[tier]) missing.push(`MCP_API_HOST_${tier.toUpperCase()}`);
    if (!tokenUrls[tier]) missing.push(tokenName);
    if (missing.length > 0) {
      const label = tier === "sandbox" ? "Sandbox" : "Live";
      console.error(
        `[proxy] incomplete ${tier} authentication: missing ${missing.join(", ")}. ${label} calls are unavailable.`,
      );
    }
  }
}

export function getConfig(): Config {
  const env = parseEnv(process.env.MCP_ENV);
  const defaults = env === "prod" ? PROD_DEFAULTS : NON_PROD_DEFAULTS;

  const mcpServerUrl = process.env.MCP_SERVER_URL ?? defaults.mcpServerUrl;
  const sandboxHost =
    process.env.MCP_API_HOST_SANDBOX ?? defaults.apiHosts.sandbox;
  const liveHost = process.env.MCP_API_HOST_LIVE ?? defaults.apiHosts.live;
  const apiHosts: ApiHosts = {
    mock: process.env.MCP_API_HOST_MOCK ?? defaults.apiHosts.mock,
    ...(sandboxHost ? { sandbox: sandboxHost } : {}),
    ...(liveHost ? { live: liveHost } : {}),
  };

  if (!mcpServerUrl || !apiHosts.mock) {
    throw new ProxyError("configuration", { hint:
      "MCP_ENV has no built-in hosts. Set MCP_SERVER_URL and " +
        `MCP_API_HOST_MOCK (plus MCP_API_HOST_LIVE and LIVE_TOKEN_URL to call ` +
        `real APIs), or use MCP_ENV=prod, which needs no host configuration.`,
    });
  }

  const clientId = process.env.CLIENT_ID;

  // Single set of mTLS credentials shared by both sandbox and live tiers.
  const clientCert = process.env.CLIENT_CERT_PEM;
  const clientKey = process.env.CLIENT_KEY_PEM;
  const clientKeyPassphrase = process.env.CLIENT_KEY_PASSPHRASE;

  const sandboxTokenUrl =
    process.env.SANDBOX_TOKEN_URL ?? defaults.sandboxTokenUrl;
  const liveTokenUrl = process.env.LIVE_TOKEN_URL ?? defaults.liveTokenUrl;

  warnIncompleteAuth(apiHosts, { sandbox: sandboxTokenUrl, live: liveTokenUrl });

  return {
    env,
    mcpServerUrl,
    extraCaCertPath: process.env.MCP_SERVER_CA_CERT ?? defaults.extraCaCertPath,
    mcpServerApiKey: process.env.MCP_SERVER_API_KEY,
    apiHosts,
    // TODO: single scope per process for now (testing). Revisit when one
    // proxy instance must serve multiple Premium products simultaneously.
    tokenScope: process.env.TOKEN_SCOPE ?? "accounts",
    clientId,
    ...(clientId && clientCert && clientKey && sandboxTokenUrl
      ? {
          sandbox: {
            certPath: clientCert,
            keyPath: clientKey,
            ...(clientKeyPassphrase
              ? { keyPassphrase: clientKeyPassphrase }
              : {}),
            tokenUrl: sandboxTokenUrl,
          },
        }
      : {}),
    ...(clientId && clientCert && clientKey && liveTokenUrl
      ? {
          live: {
            certPath: clientCert,
            keyPath: clientKey,
            ...(clientKeyPassphrase
              ? { keyPassphrase: clientKeyPassphrase }
              : {}),
            tokenUrl: liveTokenUrl,
          },
        }
      : {}),
  };
}
