export interface TierEndpoints {
  host: string;
  /** Without a token endpoint the tier cannot authenticate and stays unavailable. */
  tokenUrl?: string;
}

/** Everything that depends on the environment. None of it is user-configurable. */
export interface EnvProfile {
  mcpServerUrl: string;
  mockHost: string;
  sandbox?: TierEndpoints;
  live?: TierEndpoints;
}

// The scope parameter is a space-delimited list (RFC 6749 section 3.3), so one
// token request covers every Premium API product. A client registered for
// fewer products narrows it with TOKEN_SCOPE.
export const DEFAULT_TOKEN_SCOPE = "accounts payments";

const PROD_PROFILE: EnvProfile = {
  mcpServerUrl: "https://mcp.danskebank.com/mcp",
  mockHost: "mock-api.danskebank.com",
  sandbox: {
    host: "sandbox-api.danskebank.com",
    tokenUrl:
      "https://sandbox-api.danskebank.com/sandbox-corporate/api/dk/business/oauth2/token",
  },
  live: {
    host: "api.danskebank.com",
    tokenUrl: "https://api.danskebank.com/corporate/api/dk/business/oauth2/token",
  },
};

const DEFAULT_ENV_WITHOUT_EXTRAS = "prod";

/** Profiles beyond production, and the environment used when `MCP_ENV` is unset. */
export interface ExtraProfiles {
  profiles: Record<string, EnvProfile>;
  defaultEnv: string;
}

const NO_EXTRA_PROFILES: ExtraProfiles = {
  profiles: {},
  defaultEnv: DEFAULT_ENV_WITHOUT_EXTRAS,
};

const EXTRA_PROFILES_MODULE = "./extra-profiles.js";

/** True when `err` says the module of `specifier` itself, not one of its imports, does not exist. */
function isMissingModule(err: unknown, specifier: string): boolean {
  const file = specifier.slice(specifier.lastIndexOf("/") + 1);
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" &&
    err.message.startsWith("Cannot find module '") &&
    err.message.includes(`${file}' imported from`)
  );
}

/**
 * Loads the optional module of extra profiles. A build without that file
 * supports production only; any other failure to load it is an error.
 */
export async function loadExtraProfiles(
  specifier: string = EXTRA_PROFILES_MODULE,
): Promise<ExtraProfiles> {
  try {
    // A variable specifier keeps the compiler from requiring the file to exist.
    const loaded = (await import(specifier)) as {
      EXTRA_PROFILES?: Record<string, EnvProfile>;
      DEFAULT_ENV?: string;
    };
    return {
      profiles: loaded.EXTRA_PROFILES ?? {},
      defaultEnv: loaded.DEFAULT_ENV ?? DEFAULT_ENV_WITHOUT_EXTRAS,
    };
  } catch (err) {
    if (isMissingModule(err, specifier)) return NO_EXTRA_PROFILES;
    throw err;
  }
}

export const extraProfiles: ExtraProfiles = await loadExtraProfiles();

/** Whether this build offers environments besides production. */
export function hasExtraProfiles(extra: ExtraProfiles = extraProfiles): boolean {
  return Object.keys(extra.profiles).length > 0;
}

function allProfiles(extra: ExtraProfiles): Record<string, EnvProfile> {
  return { prod: PROD_PROFILE, ...extra.profiles };
}

export function supportedEnvs(extra: ExtraProfiles = extraProfiles): string[] {
  return Object.keys(allProfiles(extra));
}

/**
 * The environment to run in and its profile, or undefined for an unsupported
 * name. A build without extra profiles always uses prod and ignores `value`;
 * otherwise `value` (from `MCP_ENV`) selects one, defaulting to the extras'
 * default.
 */
export function resolveProfile(
  value: string | undefined,
  extra: ExtraProfiles = extraProfiles,
): { env: string; profile: EnvProfile } | undefined {
  const requested = hasExtraProfiles(extra)
    ? value || extra.defaultEnv
    : DEFAULT_ENV_WITHOUT_EXTRAS;
  const env = requested === "production" ? "prod" : requested;
  const all = allProfiles(extra);
  return Object.hasOwn(all, env) ? { env, profile: all[env] } : undefined;
}
