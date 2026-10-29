import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_SCOPE,
  hasExtraProfiles,
  loadExtraProfiles,
  resolveProfile as resolve,
  supportedEnvs as supported,
  type EnvProfile,
  type ExtraProfiles,
} from "../src/config/profiles.js";

const fixture = (name: string) => `../../test/fixtures/${name}`;

const staging: EnvProfile = {
  mcpServerUrl: "https://mcp.staging.example/mcp",
  mockHost: "mock.staging.example",
};

const NONE: ExtraProfiles = { profiles: {}, defaultEnv: "prod" };
const EXTRA: ExtraProfiles = { profiles: { alpha: staging, beta: staging }, defaultEnv: "alpha" };

describe("environment profiles", () => {
  const resolveProfile = (value: string | undefined, extra = EXTRA) => resolve(value, extra);
  const supportedEnvs = (extra = EXTRA) => supported(extra);

  it("requests every Premium API product in one space-delimited scope by default", () => {
    expect(DEFAULT_TOKEN_SCOPE.split(" ")).toEqual(["accounts", "payments"]);
  });

  describe("loading extra profiles", () => {
    it("supports production only when the module is absent", async () => {
      await expect(loadExtraProfiles(fixture("not-shipped.ts"))).resolves.toEqual({
        profiles: {},
        defaultEnv: "prod",
      });
    });

    it("uses the profiles and default environment the module exports", async () => {
      const loaded = await loadExtraProfiles(fixture("extras-present.ts"));
      expect(Object.keys(loaded.profiles)).toEqual(["alpha"]);
      expect(loaded.defaultEnv).toBe("alpha");
    });

    it("treats a module without exports as having no extras", async () => {
      await expect(loadExtraProfiles(fixture("extras-empty.ts"))).resolves.toEqual({
        profiles: {},
        defaultEnv: "prod",
      });
    });

    it("does not hide a module that fails to load", async () => {
      await expect(loadExtraProfiles(fixture("extras-throws.ts"))).rejects.toThrow(
        "extras failed to initialise",
      );
    });

    it("does not mistake a missing dependency of the module for an absent module", async () => {
      await expect(loadExtraProfiles(fixture("extras-missing-dependency.ts"))).rejects.toThrow(
        /does-not-exist/,
      );
    });
  });

  describe("production profile", () => {
    const prod = () => resolveProfile("prod")!.profile;

    it("uses https endpoints on danskebank.com only", () => {
      const { mcpServerUrl, mockHost, sandbox, live } = prod();
      const urls = [
        mcpServerUrl,
        `https://${mockHost}`,
        `https://${sandbox?.host}`,
        sandbox?.tokenUrl,
        `https://${live?.host}`,
        live?.tokenUrl,
      ];
      for (const url of urls) {
        expect(url).toMatch(/^https:\/\/[a-z-]+\.danskebank\.com(\/|$)/);
      }
    });

    it.each(["sandbox", "live"] as const)("signs in the %s tier on its own host", (tier) => {
      const endpoints = prod()[tier]!;
      expect(new URL(endpoints.tokenUrl!).host).toBe(endpoints.host);
    });
  });

  describe("environment selection", () => {
    it("lists production first, then the extra environments", () => {
      expect(supportedEnvs()).toEqual(["prod", "alpha", "beta"]);
    });

    it("selects the requested extra environment and falls back to its default", () => {
      expect(resolveProfile("beta")).toEqual({ env: "beta", profile: staging });
      expect(resolveProfile(undefined)?.env).toBe("alpha");
      expect(resolveProfile("")?.env).toBe("alpha");
    });

    it.each(["prod", "production"])("accepts %s for production", (value) => {
      expect(resolveProfile(value)?.env).toBe("prod");
    });

    it.each(["unknown", "PROD", "constructor", "__proto__", "hasOwnProperty"])(
      "rejects %j instead of resolving an inherited property",
      (value) => {
        expect(resolveProfile(value)).toBeUndefined();
      },
    );

    it("always selects production, whatever is requested, without extra profiles", () => {
      expect(hasExtraProfiles(NONE)).toBe(false);
      expect(supportedEnvs(NONE)).toEqual(["prod"]);
      for (const value of [undefined, "", "alpha", "beta", "unknown", "constructor"]) {
        expect(resolveProfile(value, NONE)?.env).toBe("prod");
      }
    });
  });
});
