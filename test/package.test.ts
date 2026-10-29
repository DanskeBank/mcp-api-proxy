import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";

const manifest = z.object({
  engines: z.object({ node: z.string() }),
  scripts: z.record(z.string(), z.string()),
  devDependencies: z.object({
    vitest: z.string(),
    "@vitest/coverage-v8": z.string(),
  }),
}).parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));

const lock = z.object({
  packages: z.record(z.string(), z.object({
    version: z.string(),
    engines: z.object({ node: z.string().optional() }).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
  })),
}).parse(JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")));

describe("package compatibility", () => {
  it("declares supported Node baselines consistently in the manifest and lockfile", () => {
    expect(manifest.engines.node).toBe("^22.13.0 || >=24.0.0");
    expect(lock.packages[""].engines?.node).toBe(manifest.engines.node);
  });

  it("keeps Vitest and its coverage provider on matching fixed versions", () => {
    expect(manifest.devDependencies.vitest).toBe("^4.1.12");
    expect(manifest.devDependencies["@vitest/coverage-v8"]).toBe(manifest.devDependencies.vitest);
    expect(lock.packages["node_modules/@vitest/coverage-v8"].peerDependencies?.vitest)
      .toBe(lock.packages["node_modules/vitest"].version);
  });

  it("does not expose the internal public-export command as a package script", () => {
    expect(manifest.scripts).not.toHaveProperty("build:public");
    expect(Object.values(manifest.scripts).join("\n")).not.toContain("prepare-public.ps1");
  });

  it("type-checks tests in a no-emit Node-aware project", () => {
    const configUrl = new URL("./tsconfig.json", import.meta.url);
    const config = ts.readConfigFile(fileURLToPath(configUrl), ts.sys.readFile);
    expect(config.error).toBeUndefined();

    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      fileURLToPath(new URL(".", configUrl)),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.options.noEmit).toBe(true);
    expect(parsed.options.types).toContain("node");
    expect(parsed.options.moduleResolution).toBe(ts.ModuleResolutionKind.NodeNext);
    expect(parsed.fileNames).toContain(fileURLToPath(new URL("./version.test.ts", import.meta.url)));
    expect(manifest.scripts.typecheck).toContain("tsc --noEmit -p test/tsconfig.json");
  });
});
