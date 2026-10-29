import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import type { EnvProfile, ExtraProfiles } from "../src/config/profiles.js";
import {
  configFor,
  loadSettingsFile,
  warnRemovedSettings as warnRemoved,
} from "../src/config/config.js";

// Synthetic profiles keep these tests independent of the real hosts and of
// whether this build has extra profiles at all.
const EXTRA_PROFILES: Record<string, EnvProfile> = {
  // Mock tier only.
  alpha: {
    mcpServerUrl: "https://mcp.alpha.example/mcp",
    mockHost: "mock.alpha.example",
  },
  // Authenticated live tier.
  beta: {
    mcpServerUrl: "https://mcp.beta.example/mcp",
    mockHost: "mock.beta.example",
    live: {
      host: "api.beta.example",
      tokenUrl: "https://api.beta.example/dk/oauth2/token",
    },
  },
  // A live host without a token endpoint.
  gamma: {
    mcpServerUrl: "https://mcp.gamma.example/mcp",
    mockHost: "mock.gamma.example",
    live: { host: "api.gamma.example" },
  },
};

const EXTRA: ExtraProfiles = { profiles: EXTRA_PROFILES, defaultEnv: "alpha" };
const NONE: ExtraProfiles = { profiles: {}, defaultEnv: "prod" };

const MANAGED_VARS = [
  "MCP_ENV",
  "MCP_SERVER_API_KEY",
  "MCP_SERVER_CA_CERT",
  "CLIENT_ID",
  "CLIENT_CERT_PEM",
  "CLIENT_KEY_PEM",
  "CLIENT_KEY_PASSPHRASE",
  "MCP_SERVER_URL",
  "MCP_API_HOST_MOCK",
  "MCP_API_HOST_SANDBOX",
  "MCP_API_HOST_LIVE",
  "SANDBOX_TOKEN_URL",
  "LIVE_TOKEN_URL",
  "TOKEN_SCOPE",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "MCP_MAX_SESSIONS",
  "MCP_SESSION_TTL_MS",
  "MCP_RATE_LIMIT_PER_IP",
  "MCP_RATE_LIMIT_WINDOW_MS",
  "MCP_TRUST_PROXY",
];

const PROD_SANDBOX_TOKEN_URL =
  "https://sandbox-api.danskebank.com/sandbox-corporate/api/dk/business/oauth2/token";
const PROD_LIVE_TOKEN_URL = "https://api.danskebank.com/corporate/api/dk/business/oauth2/token";

function setCredentials(): void {
  process.env.CLIENT_ID = "abc";
  process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
  process.env.CLIENT_KEY_PEM = "/tmp/client.key";
}

describe("configuration", () => {
  let originalEnv: Record<string, string | undefined>;
  let extra: ExtraProfiles;
  const getConfig = () => configFor(extra);
  const warnRemovedSettings = () => warnRemoved(extra);

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    extra = EXTRA;
    originalEnv = {};
    for (const name of MANAGED_VARS) {
      originalEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
  });

  function diagnostics(): string {
    return vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
  }

  describe("with extra profiles", () => {
    it("defaults to the default extra environment: mock tier only, no credentials", () => {
      const cfg = getConfig();
      expect(cfg.env).toBe("alpha");
      expect(cfg.mcpServerUrl).toBe("https://mcp.alpha.example/mcp");
      expect(cfg.apiHosts).toEqual({ mock: "mock.alpha.example" });
      expect(cfg.extraCaCertPath).toBeUndefined();
      expect(cfg.tokenScope).toBe("accounts payments");
      expect(cfg.clientId).toBeUndefined();
      expect(cfg.sandbox).toBeUndefined();
      expect(cfg.live).toBeUndefined();
    });

    it("treats an empty MCP_ENV as the default extra environment", () => {
      process.env.MCP_ENV = "";
      expect(getConfig().env).toBe("alpha");
    });

    it("takes the hosts of the selected environment from its profile", () => {
      process.env.MCP_ENV = "beta";
      const cfg = getConfig();
      expect(cfg.env).toBe("beta");
      expect(cfg.mcpServerUrl).toBe("https://mcp.beta.example/mcp");
      expect(cfg.apiHosts).toEqual({ mock: "mock.beta.example", live: "api.beta.example" });
    });

    it.each(["prod", "production"])("selects the production profile with MCP_ENV=%s", (value) => {
      process.env.MCP_ENV = value;
      const cfg = getConfig();
      expect(cfg.env).toBe("prod");
      expect(cfg.mcpServerUrl).toBe("https://mcp.danskebank.com/mcp");
    });

    it.each(["staging", "constructor", "__proto__", "toString"])(
      "rejects the unsupported environment %j",
      (value) => {
        process.env.MCP_ENV = value;
        expect(() => getConfig()).toThrow(
          "[configuration]: Invalid MCP_ENV. Supported: prod, alpha, beta, gamma.",
        );
      },
    );

    it("does not include the rejected value in the error", () => {
      process.env.MCP_ENV = "private-environment-123";
      let message = "";
      try {
        getConfig();
      } catch (err) {
        message = String(err);
      }
      expect(message).toContain("Invalid MCP_ENV");
      expect(message).not.toContain("private-environment-123");
    });

    it("populates live auth from the profile when the credentials are complete", () => {
      process.env.MCP_ENV = "beta";
      setCredentials();
      process.env.CLIENT_KEY_PASSPHRASE = "livepass";
      const cfg = getConfig();
      expect(cfg.sandbox).toBeUndefined();
      expect(cfg.live).toEqual({
        certPath: "/tmp/client.crt",
        keyPath: "/tmp/client.key",
        keyPassphrase: "livepass",
        tokenUrl: "https://api.beta.example/dk/oauth2/token",
      });
    });

    it("has no authenticated tier in an environment without token endpoints", () => {
      setCredentials();
      expect(getConfig().live).toBeUndefined();
      process.env.MCP_ENV = "gamma";
      expect(getConfig().live).toBeUndefined();
    });

    it("does not offer the host of a tier that has no token endpoint", () => {
      process.env.MCP_ENV = "gamma";
      setCredentials();
      expect(getConfig().apiHosts).toEqual({ mock: "mock.gamma.example" });
    });
  });

  describe("without extra profiles (production only)", () => {
    beforeEach(() => {
      extra = NONE;
    });

    it.each([undefined, "alpha", "beta", "private-environment-123"])(
      "always uses production and ignores MCP_ENV=%j",
      (value) => {
        if (value !== undefined) process.env.MCP_ENV = value;
        const cfg = getConfig();
        expect(cfg.env).toBe("prod");
        expect(cfg.mcpServerUrl).toBe("https://mcp.danskebank.com/mcp");
        expect(console.error).not.toHaveBeenCalled();
      },
    );

    it("has all three tiers with the production hosts", () => {
      const cfg = getConfig();
      expect(cfg.apiHosts).toEqual({
        mock: "mock-api.danskebank.com",
        sandbox: "sandbox-api.danskebank.com",
        live: "api.danskebank.com",
      });
      expect(cfg.extraCaCertPath).toBeUndefined();
      expect(cfg.mcpServerApiKey).toBeUndefined();
      expect(cfg.tokenScope).toBe("accounts payments");
    });

    it("populates sandbox and live auth, each with its own token endpoint", () => {
      setCredentials();
      process.env.CLIENT_KEY_PASSPHRASE = "topsecret";
      const cfg = getConfig();
      expect(cfg.sandbox).toEqual({
        certPath: "/tmp/client.crt",
        keyPath: "/tmp/client.key",
        keyPassphrase: "topsecret",
        tokenUrl: PROD_SANDBOX_TOKEN_URL,
      });
      expect(cfg.live).toEqual({
        certPath: "/tmp/client.crt",
        keyPath: "/tmp/client.key",
        keyPassphrase: "topsecret",
        tokenUrl: PROD_LIVE_TOKEN_URL,
      });
    });

    it("omits keyPassphrase when not provided", () => {
      setCredentials();
      expect(getConfig().sandbox?.keyPassphrase).toBeUndefined();
    });

    it("ignores cert and key without CLIENT_ID", () => {
      process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
      process.env.CLIENT_KEY_PEM = "/tmp/client.key";
      const cfg = getConfig();
      expect(cfg.sandbox).toBeUndefined();
      expect(cfg.live).toBeUndefined();
    });

    it("requires both the certificate and the key for auth", () => {
      process.env.CLIENT_ID = "abc";
      process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
      const cfg = getConfig();
      expect(cfg.sandbox).toBeUndefined();
      expect(cfg.live).toBeUndefined();
    });
  });

  describe.each([
    ["with extra profiles", EXTRA],
    ["without extra profiles", NONE],
  ])("settings %s", (_name, profiles) => {
    beforeEach(() => {
      extra = profiles;
    });

    it("cannot redirect hosts or token endpoints through settings", () => {
      const baseline = getConfig();
      process.env.MCP_SERVER_URL = "https://evil.example/mcp";
      process.env.MCP_API_HOST_MOCK = "evil.example";
      process.env.MCP_API_HOST_SANDBOX = "evil.example";
      process.env.MCP_API_HOST_LIVE = "evil.example";
      process.env.SANDBOX_TOKEN_URL = "https://evil.example/token";
      process.env.LIVE_TOKEN_URL = "https://evil.example/token";
      setCredentials();

      const cfg = getConfig();
      expect(cfg.mcpServerUrl).toBe(baseline.mcpServerUrl);
      expect(cfg.apiHosts).toEqual(baseline.apiHosts);
      expect(JSON.stringify(cfg)).not.toContain("evil");
    });

    it("requests both Premium API scopes unless TOKEN_SCOPE narrows them", () => {
      expect(getConfig().tokenScope).toBe("accounts payments");

      process.env.TOKEN_SCOPE = "accounts";
      expect(getConfig().tokenScope).toBe("accounts");
    });

    it.each([
      ["  accounts   payments  ", "accounts payments"],
      ["payments\taccounts", "payments accounts"],
      ["", "accounts payments"],
      ["   ", "accounts payments"],
    ])("normalises TOKEN_SCOPE %j to %j", (value, expected) => {
      process.env.TOKEN_SCOPE = value;
      expect(getConfig().tokenScope).toBe(expected);
    });

    it("does not warn about TOKEN_SCOPE, which is a supported setting", () => {
      process.env.TOKEN_SCOPE = "accounts";
      getConfig();
      warnRemovedSettings();
      expect(console.error).not.toHaveBeenCalled();
    });

    it("picks up MCP_SERVER_API_KEY", () => {
      expect(getConfig().mcpServerApiKey).toBeUndefined();
      process.env.MCP_SERVER_API_KEY = "test-api-key";
      expect(getConfig().mcpServerApiKey).toBe("test-api-key");
    });

    it("picks up the extra CA bundle path from MCP_SERVER_CA_CERT", () => {
      process.env.MCP_SERVER_CA_CERT = "/tmp/ca.pem";
      expect(getConfig().extraCaCertPath).toBe("/tmp/ca.pem");
    });
  });

  describe("partial authentication diagnostics", () => {
    const sentinel = "private-auth-setting-8675309";

    function setAuthSettings(): void {
      process.env.MCP_ENV = "beta";
      process.env.CLIENT_ID = sentinel;
      process.env.CLIENT_CERT_PEM = `/example/${sentinel}/cert.pem`;
      process.env.CLIENT_KEY_PEM = `/example/${sentinel}/key.pem`;
      process.env.CLIENT_KEY_PASSPHRASE = sentinel;
    }

    it.each(["CLIENT_ID", "CLIENT_CERT_PEM", "CLIENT_KEY_PEM"])(
      "names missing %s without exposing any setting values",
      (name) => {
        setAuthSettings();
        delete process.env[name];

        expect(getConfig().live).toBeUndefined();
        expect(diagnostics()).toContain(
          `[proxy] incomplete live authentication: missing ${name}. Live calls are unavailable.`,
        );
        expect(diagnostics()).not.toContain(sentinel);
        expect(diagnostics()).not.toContain("sandbox");
      },
    );

    it.each(["CLIENT_ID", "CLIENT_CERT_PEM", "CLIENT_KEY_PEM"])(
      "reports an empty %s as missing",
      (name) => {
        setAuthSettings();
        process.env[name] = "";

        expect(getConfig().live).toBeUndefined();
        expect(diagnostics()).toContain(`missing ${name}.`);
        expect(diagnostics()).not.toContain(sentinel);
      },
    );

    it("reports both production tiers when only the client id is set", () => {
      extra = NONE;
      process.env.CLIENT_ID = sentinel;

      const config = getConfig();

      expect(config.sandbox).toBeUndefined();
      expect(config.live).toBeUndefined();
      expect(vi.mocked(console.error).mock.calls).toEqual([
        ["[proxy] incomplete sandbox authentication: missing CLIENT_CERT_PEM, CLIENT_KEY_PEM. Sandbox calls are unavailable."],
        ["[proxy] incomplete live authentication: missing CLIENT_CERT_PEM, CLIENT_KEY_PEM. Live calls are unavailable."],
      ]);
      expect(diagnostics()).not.toContain(sentinel);
    });

    it.each(["alpha", "beta", "prod"])("does not warn for a deliberate %s setup without credentials", (env) => {
      process.env.MCP_ENV = env;
      process.env.CLIENT_ID = "";
      process.env.CLIENT_CERT_PEM = "";
      process.env.CLIENT_KEY_PEM = "";

      getConfig();

      expect(console.error).not.toHaveBeenCalled();
    });

    it("does not warn for complete credentials with a passphrase", () => {
      setAuthSettings();

      expect(getConfig().live).toBeDefined();
      expect(console.error).not.toHaveBeenCalled();
    });

    it("warns about a missing passphrase but still enables the tier, without echoing any value", () => {
      setAuthSettings();
      delete process.env.CLIENT_KEY_PASSPHRASE;

      expect(getConfig().live).toEqual(expect.objectContaining({ tokenUrl: expect.any(String) }));

      expect(console.error).toHaveBeenCalledTimes(1);
      expect(diagnostics()).toContain("[proxy] CLIENT_KEY_PASSPHRASE is not set.");
      expect(diagnostics()).not.toContain(sentinel);
    });

    it("treats an empty passphrase as missing", () => {
      setAuthSettings();
      process.env.CLIENT_KEY_PASSPHRASE = "";

      getConfig();

      expect(diagnostics()).toContain("[proxy] CLIENT_KEY_PASSPHRASE is not set.");
    });

    it("does not add the passphrase warning to an incomplete setup that is already reported", () => {
      setAuthSettings();
      delete process.env.CLIENT_KEY_PASSPHRASE;
      delete process.env.CLIENT_KEY_PEM;

      getConfig();

      expect(diagnostics()).toContain("missing CLIENT_KEY_PEM");
      expect(diagnostics()).not.toContain("CLIENT_KEY_PASSPHRASE");
    });

    it("warns about a missing passphrase in a production-only build too", () => {
      extra = NONE;
      setAuthSettings();
      delete process.env.CLIENT_KEY_PASSPHRASE;

      expect(getConfig().live).toBeDefined();

      expect(diagnostics()).toContain("[proxy] CLIENT_KEY_PASSPHRASE is not set.");
    });

    it.each(["alpha", "gamma"])(
      "does not warn about the passphrase in %s, where no tier can authenticate",
      (env) => {
        setAuthSettings();
        delete process.env.CLIENT_KEY_PASSPHRASE;
        process.env.MCP_ENV = env;

        getConfig();

        expect(diagnostics()).not.toContain("CLIENT_KEY_PASSPHRASE");
      },
    );

    it("reports missing shared credentials when only a passphrase is supplied", () => {
      process.env.MCP_ENV = "beta";
      process.env.CLIENT_KEY_PASSPHRASE = sentinel;

      getConfig();

      expect(diagnostics()).toContain(
        "missing CLIENT_ID, CLIENT_CERT_PEM, CLIENT_KEY_PEM.",
      );
      expect(diagnostics()).not.toContain(sentinel);
    });

    it("reports unused credentials in an environment without authenticated tiers", () => {
      setAuthSettings();
      process.env.MCP_ENV = "alpha";

      expect(getConfig().live).toBeUndefined();

      expect(diagnostics()).toContain(
        "[proxy] authentication settings are unused: this environment has no sandbox or live tier.",
      );
      expect(diagnostics()).not.toContain(sentinel);
    });

    it("reports a tier whose environment has no token endpoint, even with complete credentials", () => {
      setAuthSettings();
      process.env.MCP_ENV = "gamma";

      expect(getConfig().live).toBeUndefined();

      expect(diagnostics()).toContain(
        "[proxy] live authentication is not available in this environment. Live calls are unavailable.",
      );
      expect(diagnostics()).not.toContain(sentinel);
    });
  });

  describe("warnRemovedSettings", () => {
    it("stays silent when no removed setting is present", () => {
      process.env.MCP_SERVER_API_KEY = "key";
      process.env.MCP_ENV = "beta";
      warnRemovedSettings();
      expect(console.error).not.toHaveBeenCalled();
    });

    it.each([
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
    ])("names %s without exposing its value", (name) => {
      process.env[name] = "private-removed-value-123";

      warnRemovedSettings();

      expect(console.error).toHaveBeenCalledTimes(1);
      expect(diagnostics()).toContain(`no longer supported: ${name}.`);
      expect(diagnostics()).toContain("use --port and --host");
      expect(diagnostics()).not.toContain("private-removed-value-123");
    });

    it("lists every removed setting in one line", () => {
      process.env.MCP_SERVER_URL = "https://evil.example/mcp";
      process.env.LIVE_TOKEN_URL = "";

      warnRemovedSettings();

      expect(console.error).toHaveBeenCalledTimes(1);
      expect(diagnostics()).toContain("MCP_SERVER_URL, LIVE_TOKEN_URL");
      expect(diagnostics()).toContain("built into the package");
      expect(diagnostics()).not.toContain("evil.example");
    });

    it("does not list the CA path setting, which is still supported", () => {
      process.env.MCP_SERVER_CA_CERT = "/tmp/ca.pem";
      warnRemovedSettings();
      expect(console.error).not.toHaveBeenCalled();
    });

    describe("MCP_ENV", () => {
      it.each(["alpha", "beta", "private-environment-123"])(
        "is reported as ignored without extra profiles when set to %j, without its value",
        (value) => {
          extra = NONE;
          process.env.MCP_ENV = value;

          warnRemovedSettings();

          expect(console.error).toHaveBeenCalledTimes(1);
          expect(diagnostics()).toBe("[proxy] MCP_ENV is ignored: this package supports production only.");
        },
      );

      it.each([undefined, "", "prod", "production"])(
        "is not reported without extra profiles when it is %j",
        (value) => {
          extra = NONE;
          if (value !== undefined) process.env.MCP_ENV = value;
          warnRemovedSettings();
          expect(console.error).not.toHaveBeenCalled();
        },
      );

      it("is never reported when extra profiles use it", () => {
        process.env.MCP_ENV = "beta";
        warnRemovedSettings();
        expect(console.error).not.toHaveBeenCalled();
      });
    });
  });
});

describe("loadSettingsFile", () => {
  const KEY = "PROXY_SETTINGS_FILE_TEST";
  let dir: string;
  let otherCwd: string;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env[KEY];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-settings-"));
    otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-cwd-"));
  });

  afterEach(() => {
    delete process.env[KEY];
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otherCwd, { recursive: true, force: true });
  });

  function writeSettings(name: string, value: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${KEY}=${value}\n`);
    return file;
  }

  it("loads the file given with --settings-file, whatever the working directory", () => {
    const file = writeSettings("danske-proxy.env", "from-file");
    expect(
      loadSettingsFile(["node", "proxy", "--settings-file", file], otherCwd),
    ).toBe(file);
    expect(process.env[KEY]).toBe("from-file");
  });

  it("accepts --settings-file=<path> and paths relative to the working directory", () => {
    writeSettings("relative.env", "relative");
    const loaded = loadSettingsFile(["--settings-file=relative.env"], dir);
    expect(loaded).toBe(path.join(dir, "relative.env"));
    expect(process.env[KEY]).toBe("relative");
  });

  it("expands ~/ to the home directory", () => {
    writeSettings("home.env", "home");
    vi.spyOn(os, "homedir").mockReturnValue(dir);
    expect(loadSettingsFile(["--settings-file", "~/home.env"], otherCwd)).toBe(
      path.join(dir, "home.env"),
    );
    expect(process.env[KEY]).toBe("home");
  });

  it.each(["from-client-config", ""])("keeps an already-set variable (%j)", (value) => {
    process.env[KEY] = value;
    const file = writeSettings("danske-proxy.env", "from-file");
    loadSettingsFile(["--settings-file", file], otherCwd);
    expect(process.env[KEY]).toBe(value);
  });

  it("does not load the .env of the working directory, and says so", () => {
    writeSettings(".env", "implicit");
    expect(loadSettingsFile(["node", "proxy"], dir)).toBeUndefined();
    expect(process.env[KEY]).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "[proxy] the .env file in the working directory is not loaded. Pass --settings-file <path> to use it.",
    );
  });

  it("loads nothing, silently, when there is no flag and no .env", () => {
    expect(loadSettingsFile(["node", "proxy"], otherCwd)).toBeUndefined();
    expect(process.env[KEY]).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not mention a .env that is a folder", () => {
    fs.mkdirSync(path.join(otherCwd, ".env"));
    expect(loadSettingsFile(["node", "proxy"], otherCwd)).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("starts without a notice when the implicit .env cannot be inspected", () => {
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw Object.assign(new Error("private-stat-error-123"), { code: "ELOOP" });
    });
    expect(loadSettingsFile(["node", "proxy"], otherCwd)).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("fails when the file given with --settings-file is a folder", () => {
    expect(() => loadSettingsFile(["--settings-file", dir], otherCwd)).toThrow(
      "[configuration]: Cannot read the settings file (EISDIR).",
    );
  });

  it("reads only the --settings-file file, not the .env in the working directory", () => {
    const otherKey = `${KEY}_IMPLICIT`;
    fs.writeFileSync(path.join(otherCwd, ".env"), `${otherKey}=implicit\n`);
    const file = writeSettings("danske-proxy.env", "from-file");
    try {
      loadSettingsFile(["--settings-file", file], otherCwd);
      expect(process.env[KEY]).toBe("from-file");
      expect(process.env[otherKey]).toBeUndefined();
    } finally {
      delete process.env[otherKey];
    }
  });

  it("names the missing-file error without exposing the requested path", () => {
    const missing = path.join(dir, "missing.env");
    expect(() =>
      loadSettingsFile(["--settings-file", missing], otherCwd),
    ).toThrow("[configuration]: Cannot read the settings file (ENOENT).");
  });

  it.each([
    [undefined, ""],
    ["EACCES", " (EACCES)"],
  ])("preserves settings-file read errors safely with code %j", (code, suffix) => {
    const file = path.join(dir, "unreadable.env");
    const cause = Object.assign(new Error("private-settings-error-123"), { code });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw cause;
    });

    expect(() => loadSettingsFile(["--settings-file", file], otherCwd)).toThrow(
      expect.objectContaining({
        message:
          `[configuration]: Cannot read the settings file${suffix}. ` +
          "Check the path after --settings-file and that the file is readable.",
        cause,
      }),
    );
  });

  it.each([
    [["--settings-file"]],
    [["--settings-file", "--transport", "http"]],
    [["--settings-file="]],
  ])("fails when --settings-file has no path (%j)", (argv) => {
    expect(() => loadSettingsFile(argv, otherCwd)).toThrow(
      "--settings-file needs a path",
    );
  });
});
