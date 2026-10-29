import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const sentinel = "private-cli-sentinel-8675309";

describe("CLI error privacy", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-cli-privacy-"));
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it.each([
    { env: {}, args: ["--transport", "http", "--port", sentinel] },
    { env: {}, args: ["--transport", sentinel] },
  ])("does not print invalid setting values or stacks (%#)", ({ env, args }) => {
    const run = spawnSync(process.execPath, [runner, entry, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        USERPROFILE: cwd,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ...env,
      },
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toContain(sentinel);
    expect(run.stderr).not.toMatch(/\n\s+at /);
    expect(run.stderr).toContain("[configuration]");
  }, 30_000);
});