import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

describe("package version", () => {
  afterEach(() => {
    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("reads the package metadata", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const { PACKAGE_VERSION } = await import("../src/version.js");

    expect(PACKAGE_VERSION).toBe(manifest.version);
  });

  it("resolves package metadata when launched from another working directory", async () => {
    const { PACKAGE_VERSION } = await import("../src/version.js");
    const moduleUrl = new URL("../src/version.ts", import.meta.url).href;
    const run = spawnSync(process.execPath, [
      "--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
      "--input-type=module",
      "--eval",
      `import { PACKAGE_VERSION } from ${JSON.stringify(moduleUrl)}; process.stdout.write(PACKAGE_VERSION);`,
    ], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(PACKAGE_VERSION);
    expect(run.stderr).toBe("");
  }, 30_000);

  it.each(["9.8.7", "9.8.7-rc.42"])("preserves the runtime package version %s", async (version) => {
    vi.doMock("node:module", () => ({
      createRequire: (url: string) => {
        expect(url).toMatch(/\/src\/version\.ts$/);
        return (specifier: string) => {
          expect(specifier).toBe("../package.json");
          return { version };
        };
      },
    }));
    const { PACKAGE_VERSION } = await import("../src/version.js");

    expect(PACKAGE_VERSION).toBe(version);
  });

  it.each([undefined, "", 123])("rejects invalid package version %s instead of falling back", async (version) => {
    vi.doMock("node:module", () => ({
      createRequire: () => () => ({ version }),
    }));

    await expect(import("../src/version.js")).rejects.toThrow();
  });
});
