import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import { getConfig, loadSettingsFile } from "../src/config/config.js";

const STAGE2_VARS = [
  "MCP_ENV",
  "MCP_SERVER_URL",
  "MCP_SERVER_CA_CERT",
  "MCP_SERVER_API_KEY",
  "MCP_API_HOST_MOCK",
  "MCP_API_HOST_SANDBOX",
  "MCP_API_HOST_LIVE",
  "CLIENT_ID",
  "CLIENT_CERT_PEM",
  "CLIENT_KEY_PEM",
  "CLIENT_KEY_PASSPHRASE",
  "SANDBOX_TOKEN_URL",
  "TOKEN_SCOPE",
  "LIVE_TOKEN_URL",
];

/** Minimal host configuration for the internal, non-prod environments. */
function setNonProdHosts() {
  process.env.MCP_SERVER_URL = "https://mcp.example.internal/mcp";
  process.env.MCP_API_HOST_MOCK = "mock-api.example.internal";
  process.env.MCP_API_HOST_LIVE = "api.example.internal";
}

describe("getConfig", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    originalEnv = {};
    for (const k of STAGE2_VARS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("defaults to test env with no bundled CA and no auth", () => {
    setNonProdHosts();
    const cfg = getConfig();
    expect(cfg.env).toBe("test");
    expect(cfg.mcpServerUrl).toBe("https://mcp.example.internal/mcp");
    expect(cfg.extraCaCertPath).toBeUndefined();
    expect(cfg.tokenScope).toBe("accounts");
    expect(cfg.clientId).toBeUndefined();
    expect(cfg.sandbox).toBeUndefined();
    expect(cfg.live).toBeUndefined();
  });

  it("non-prod envs take their hosts from MCP_API_HOST_*", () => {
    process.env.MCP_ENV = "syst";
    setNonProdHosts();
    const cfg = getConfig();
    expect(cfg.apiHosts.mock).toBe("mock-api.example.internal");
    expect(cfg.apiHosts.live).toBe("api.example.internal");
    expect(cfg.apiHosts.sandbox).toBeUndefined();
  });

  it("non-prod envs throw when hosts are not configured", () => {
    process.env.MCP_ENV = "syst";
    expect(() => getConfig()).toThrow(/no built-in hosts/);
  });

  it("host overrides apply to prod too", () => {
    process.env.MCP_ENV = "prod";
    process.env.MCP_API_HOST_LIVE = "api.example.internal";
    const cfg = getConfig();
    expect(cfg.apiHosts.live).toBe("api.example.internal");
    expect(cfg.apiHosts.mock).toBe("mock-api.danskebank.com");
  });

  it("prod env has all three host tiers", () => {
    process.env.MCP_ENV = "prod";
    const cfg = getConfig();
    expect(cfg.apiHosts.mock).toBe("mock-api.danskebank.com");
    expect(cfg.apiHosts.sandbox).toBe("sandbox-api.danskebank.com");
    expect(cfg.apiHosts.live).toBe("api.danskebank.com");
    expect(cfg.mcpServerUrl).toBe("https://mcp.danskebank.com/mcp");
    expect(cfg.extraCaCertPath).toBeUndefined();
    expect(cfg.mcpServerApiKey).toBeUndefined();
  });

  it("treats an arbitrary MCP_ENV value as a custom non-prod tier", () => {
    process.env.MCP_ENV = "staging";
    setNonProdHosts();
    const cfg = getConfig();
    expect(cfg.env).toBe("staging");
  });

  it("leaves mcpServerApiKey undefined when MCP_SERVER_API_KEY is not set", () => {
    setNonProdHosts();
    const cfg = getConfig();
    expect(cfg.mcpServerApiKey).toBeUndefined();
  });

  it("picks up MCP_SERVER_API_KEY regardless of MCP_ENV", () => {
    process.env.MCP_ENV = "prod";
    process.env.MCP_SERVER_API_KEY = "test-api-key";
    const cfg = getConfig();
    expect(cfg.mcpServerApiKey).toBe("test-api-key");
  });

  it("populates sandbox auth in prod env when CLIENT_ID + cert + key are set", () => {
    process.env.MCP_ENV = "prod";
    process.env.CLIENT_ID = "abc";
    process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
    process.env.CLIENT_KEY_PEM = "/tmp/client.key";
    process.env.CLIENT_KEY_PASSPHRASE = "topsecret";
    const cfg = getConfig();
    expect(cfg.sandbox).toEqual({
      certPath: "/tmp/client.crt",
      keyPath: "/tmp/client.key",
      keyPassphrase: "topsecret",
      tokenUrl:
        "https://sandbox-api.danskebank.com/sandbox-corporate/api/dk/business/oauth2/token",
    });
    // live is also populated (same certs, different token URL)
    expect(cfg.live).toEqual({
      certPath: "/tmp/client.crt",
      keyPath: "/tmp/client.key",
      keyPassphrase: "topsecret",
      tokenUrl: "https://api.danskebank.com/corporate/api/dk/business/oauth2/token",
    });
  });

  it("does not populate sandbox auth when MCP_ENV has no sandbox tier (syst)", () => {
    process.env.MCP_ENV = "syst";
    setNonProdHosts();
    process.env.CLIENT_ID = "abc";
    process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
    process.env.CLIENT_KEY_PEM = "/tmp/client.key";
    const cfg = getConfig();
    expect(cfg.sandbox).toBeUndefined();
  });

  it("omits keyPassphrase when not provided", () => {
    process.env.MCP_ENV = "prod";
    process.env.CLIENT_ID = "abc";
    process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
    process.env.CLIENT_KEY_PEM = "/tmp/client.key";
    const cfg = getConfig();
    expect(cfg.sandbox?.keyPassphrase).toBeUndefined();
  });

  it("defaults sandbox/live token URLs per MCP_ENV", () => {
    process.env.CLIENT_ID = "abc";
    process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
    process.env.CLIENT_KEY_PEM = "/tmp/client.key";

    process.env.MCP_ENV = "syst";
    setNonProdHosts();
    process.env.LIVE_TOKEN_URL = "https://api.example.internal/oauth2/token";
    let cfg = getConfig();
    // syst has no sandbox tier
    expect(cfg.sandbox).toBeUndefined();
    expect(cfg.live?.tokenUrl).toBe(
      "https://api.example.internal/oauth2/token",
    );

    delete process.env.LIVE_TOKEN_URL;
    process.env.MCP_ENV = "prod";
    cfg = getConfig();
    expect(cfg.sandbox?.tokenUrl).toBe(
      "https://sandbox-api.danskebank.com/sandbox-corporate/api/dk/business/oauth2/token",
    );
    expect(cfg.live?.tokenUrl).toBe(
      "https://api.danskebank.com/corporate/api/dk/business/oauth2/token",
    );
  });

  it("lets SANDBOX_TOKEN_URL / LIVE_TOKEN_URL override env defaults", () => {
    process.env.MCP_ENV = "prod";
    process.env.CLIENT_ID = "abc";
    process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
    process.env.CLIENT_KEY_PEM = "/tmp/client.key";
    process.env.SANDBOX_TOKEN_URL = "https://custom/sandbox";
    process.env.LIVE_TOKEN_URL = "https://custom/live";
    const cfg = getConfig();
    expect(cfg.sandbox?.tokenUrl).toBe("https://custom/sandbox");
    expect(cfg.live?.tokenUrl).toBe("https://custom/live");
  });

  it("populates live auth with optional passphrase", () => {
    setNonProdHosts();
    process.env.CLIENT_ID = "abc";
    process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
    process.env.CLIENT_KEY_PEM = "/tmp/client.key";
    process.env.CLIENT_KEY_PASSPHRASE = "livepass";
    process.env.LIVE_TOKEN_URL = "https://example.com/token";
    const cfg = getConfig();
    expect(cfg.live).toEqual({
      certPath: "/tmp/client.crt",
      keyPath: "/tmp/client.key",
      keyPassphrase: "livepass",
      tokenUrl: "https://example.com/token",
    });
  });

  it("ignores cert+key without CLIENT_ID", () => {
    process.env.MCP_ENV = "prod";
    process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
    process.env.CLIENT_KEY_PEM = "/tmp/client.key";
    const cfg = getConfig();
    expect(cfg.sandbox).toBeUndefined();
  });

  it("requires both cert AND key for auth", () => {
    process.env.MCP_ENV = "prod";
    process.env.CLIENT_ID = "abc";
    process.env.CLIENT_CERT_PEM = "/tmp/client.crt";
    // CLIENT_KEY_PEM intentionally missing
    const cfg = getConfig();
    expect(cfg.sandbox).toBeUndefined();
    expect(cfg.live).toBeUndefined();
  });

  it("respects MCP_SERVER_URL and MCP_SERVER_CA_CERT overrides", () => {
    setNonProdHosts();
    process.env.MCP_SERVER_URL = "https://example.com/mcp";
    process.env.MCP_SERVER_CA_CERT = "/tmp/ca.pem";
    const cfg = getConfig();
    expect(cfg.mcpServerUrl).toBe("https://example.com/mcp");
    expect(cfg.extraCaCertPath).toBe("/tmp/ca.pem");
  });

  describe("partial authentication diagnostics", () => {
    const sentinel = "private-auth-setting-8675309";

    function setAuthSettings(): void {
      setNonProdHosts();
      process.env.CLIENT_ID = sentinel;
      process.env.CLIENT_CERT_PEM = `/example/${sentinel}/cert.pem`;
      process.env.CLIENT_KEY_PEM = `/example/${sentinel}/key.pem`;
      process.env.CLIENT_KEY_PASSPHRASE = sentinel;
      process.env.LIVE_TOKEN_URL = `https://auth.example.test/${sentinel}`;
    }

    function diagnostics(): string {
      return vi.mocked(console.error).mock.calls.map((args) => format(...args)).join("\n");
    }

    it.each([
      "CLIENT_ID",
      "CLIENT_CERT_PEM",
      "CLIENT_KEY_PEM",
      "LIVE_TOKEN_URL",
    ])("names missing %s without exposing any setting values", (name) => {
      setAuthSettings();
      delete process.env[name];

      expect(getConfig().live).toBeUndefined();
      expect(diagnostics()).toContain(
        `[proxy] incomplete live authentication: missing ${name}.`,
      );
      expect(diagnostics()).not.toContain(sentinel);
      expect(diagnostics()).not.toContain("sandbox");
    });

    it.each(["CLIENT_ID", "CLIENT_CERT_PEM", "CLIENT_KEY_PEM", "LIVE_TOKEN_URL"])(
      "reports an empty %s as missing",
      (name) => {
        setAuthSettings();
        process.env[name] = "";

        expect(getConfig().live).toBeUndefined();
        expect(diagnostics()).toContain(`missing ${name}.`);
        expect(diagnostics()).not.toContain(sentinel);
      },
    );

    it("reports both configured production tiers but not defaulted token URLs", () => {
      process.env.MCP_ENV = "prod";
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

    it.each(["test", "prod"])("does not warn for a deliberate %s mock-only setup", (env) => {
      setNonProdHosts();
      process.env.MCP_ENV = env;
      process.env.TOKEN_SCOPE = "accounts";
      process.env.CLIENT_ID = "";
      process.env.CLIENT_CERT_PEM = "";
      process.env.CLIENT_KEY_PEM = "";

      getConfig();

      expect(console.error).not.toHaveBeenCalled();
    });

    it("does not warn for complete credentials or require an optional passphrase", () => {
      setAuthSettings();
      delete process.env.CLIENT_KEY_PASSPHRASE;

      expect(getConfig().live).toBeDefined();
      expect(console.error).not.toHaveBeenCalled();
    });

    it("reports missing shared credentials when only a passphrase is supplied", () => {
      setNonProdHosts();
      process.env.CLIENT_KEY_PASSPHRASE = sentinel;

      getConfig();

      expect(diagnostics()).toContain(
        "missing CLIENT_ID, CLIENT_CERT_PEM, CLIENT_KEY_PEM, LIVE_TOKEN_URL.",
      );
      expect(diagnostics()).not.toContain(sentinel);
    });

    it("treats an explicit token URL as an authentication attempt", () => {
      setNonProdHosts();
      process.env.LIVE_TOKEN_URL = `https://auth.example.test/${sentinel}`;

      getConfig();

      expect(diagnostics()).toContain("missing CLIENT_ID, CLIENT_CERT_PEM, CLIENT_KEY_PEM.");
      expect(diagnostics()).not.toContain(sentinel);
      expect(diagnostics()).not.toContain("sandbox");
    });

    it("names the missing host for an explicitly configured token tier", () => {
      setAuthSettings();
      process.env.SANDBOX_TOKEN_URL = `https://auth.example.test/${sentinel}`;

      getConfig();

      expect(diagnostics()).toContain("missing MCP_API_HOST_SANDBOX.");
      expect(diagnostics()).not.toContain(sentinel);
    });

    it("reports unused authentication settings when no authenticated host exists", () => {
      setAuthSettings();
      delete process.env.MCP_API_HOST_LIVE;
      delete process.env.LIVE_TOKEN_URL;

      getConfig();

      expect(diagnostics()).toContain("MCP_API_HOST_SANDBOX or MCP_API_HOST_LIVE");
      expect(diagnostics()).not.toContain(sentinel);
    });
  });
});

describe("loadSettingsFile", () => {
  const KEY = "PROXY_SETTINGS_FILE_TEST";
  let dir: string;
  let otherCwd: string;

  beforeEach(() => {
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

  it("falls back to .env in the working directory without --settings-file", () => {
    const file = writeSettings(".env", "implicit");
    expect(loadSettingsFile(["node", "proxy"], dir)).toBe(file);
    expect(process.env[KEY]).toBe("implicit");
  });

  it("loads nothing when there is no flag and no .env", () => {
    expect(loadSettingsFile(["node", "proxy"], otherCwd)).toBeUndefined();
    expect(process.env[KEY]).toBeUndefined();
  });

  it("skips a .env that is a folder when --settings-file is not given", () => {
    fs.mkdirSync(path.join(otherCwd, ".env"));
    expect(loadSettingsFile(["node", "proxy"], otherCwd)).toBeUndefined();
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

  it("does not include a custom environment value in configuration errors", () => {
    const originalEnv = process.env;
    process.env = { MCP_ENV: "private-environment-123" };
    try {
      expect(() => getConfig()).toThrow("[configuration]: MCP_ENV has no built-in hosts.");
      expect(() => getConfig()).not.toThrow("private-environment-123");
    } finally {
      process.env = originalEnv;
    }
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
