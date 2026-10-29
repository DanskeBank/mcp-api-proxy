import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReleaseProvenance, resolveReleaseTools } from "../scripts/release-provenance.js";

const releaseNotes = readFileSync(new URL("../RELEASE-NOTES.md", import.meta.url), "utf8");
const script = fileURLToPath(new URL("../scripts/release-provenance.ts", import.meta.url));
const version = "9.8.7-rc.42";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

function fixtureExecutable(command: string): string {
  const name = process.platform === "win32" ? `${command}.exe` : command;
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    if (!existsSync(candidate)) continue;
    const stat = statSync(candidate);
    if (stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0)) {
      return candidate;
    }
  }
  throw new Error(`Release tests require ${command} installed on PATH.`);
}

const fixtureGit = fixtureExecutable("git");
const fixtureTar = fixtureExecutable("tar");
const fixtureToolPath = [...new Set([
  dirname(fixtureGit),
  dirname(fixtureTar),
  ...(process.env.PATH ?? process.env.Path ?? "").split(delimiter)
    .filter(Boolean).map((directory) => resolve(directory)),
])].join(delimiter);

describe("public release notes", () => {
  it("keeps public release notes usable without checksum generation", () => {
    expect(releaseNotes).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(releaseNotes).not.toMatch(/SHA-256|SHA256SUMS/);
    expect(releaseNotes).toContain("## Changes");
    expect(releaseNotes).toContain("## Known limits");
    expect(releaseNotes).toContain("https://developers.danskebank.com/premium-apis/contact-us");
  });
});

describe("release tool configuration", () => {
  const unixTools = {
    PROVENANCE_GIT_EXECUTABLE: "/usr/bin/git",
    PROVENANCE_TAR_EXECUTABLE: "/usr/bin/tar",
  };
  const windowsTools = {
    PROVENANCE_GIT_EXECUTABLE: String.raw`C:\Program Files\Git\cmd\git.exe`,
    PROVENANCE_TAR_EXECUTABLE: String.raw`C:\Windows\System32\tar.exe`,
  };

  it.each(["linux", "darwin"] satisfies NodeJS.Platform[])(
    "uses configured tools without inheriting PATH on %s", (platform) => {
      const environment = { ...unixTools, PATH: "/untrusted/bin", OTHER: "preserved" };
      const tools = resolveReleaseTools(environment, platform);
      expect(tools.git).toBe(unixTools.PROVENANCE_GIT_EXECUTABLE);
      expect(tools.tar).toBe(unixTools.PROVENANCE_TAR_EXECUTABLE);
      expect(tools.env.PATH).toBe("/usr/bin");
      expect(tools.env.OTHER).toBe("preserved");
      expect(environment.PATH).toBe("/untrusted/bin");
    },
  );

  it("uses fully qualified Windows paths, semicolons and one canonical PATH key", () => {
    const tools = resolveReleaseTools({
      ...windowsTools,
      PROVENANCE_TOOL_PATH: String.raw`C:\Program Files\Git\usr\bin;C:\Windows\System32`,
      PATH: String.raw`C:\untrusted`,
      Path: String.raw`D:\untrusted`,
      pAtH: String.raw`E:\untrusted`,
    }, "win32");
    expect(tools.git).toBe(windowsTools.PROVENANCE_GIT_EXECUTABLE);
    expect(tools.tar).toBe(windowsTools.PROVENANCE_TAR_EXECUTABLE);
    expect(tools.env.PATH).toBe(
      String.raw`C:\Program Files\Git\cmd;C:\Windows\System32;C:\Program Files\Git\usr\bin`,
    );
    expect(Object.keys(tools.env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
  });

  it("accepts explicitly trusted UNC executables on Windows", () => {
    const git = String.raw`\\files.example.invalid\approved\git.exe`;
    const tools = resolveReleaseTools({
      ...windowsTools, PROVENANCE_GIT_EXECUTABLE: git,
    }, "win32");
    expect(tools.git).toBe(git);
    expect(tools.env.PATH).toBe(
      String.raw`\\files.example.invalid\approved\;C:\Windows\System32`,
    );
  });

  it("includes and deduplicates only explicitly approved helper directories", () => {
    const tools = resolveReleaseTools({
      ...unixTools, PROVENANCE_TOOL_PATH: "/bin:/opt/approved helpers:/usr/bin",
    }, "linux");
    expect(tools.env.PATH).toBe("/usr/bin:/bin:/opt/approved helpers");
  });

  it.each([
    { PROVENANCE_GIT_EXECUTABLE: undefined },
    { PROVENANCE_TAR_EXECUTABLE: undefined },
    { PROVENANCE_GIT_EXECUTABLE: "git" },
    { PROVENANCE_TAR_EXECUTABLE: "./tar" },
    { PROVENANCE_TOOL_PATH: "" },
    { PROVENANCE_TOOL_PATH: "/usr/bin:" },
    { PROVENANCE_TOOL_PATH: "/usr/bin:." },
  ])("rejects missing or relative release configuration: %j", (invalid) => {
    expect(() => resolveReleaseTools({ ...unixTools, ...invalid }, "linux")).toThrow();
  });

  it.each(["git.exe", String.raw`C:git.exe`, String.raw`\Tools\git.exe`, "/Tools/git.exe"])(
    "rejects a Windows executable without a drive or UNC root: %s", (git) => {
      expect(() => resolveReleaseTools({
        ...windowsTools, PROVENANCE_GIT_EXECUTABLE: git,
      }, "win32")).toThrow("fully qualified absolute path");
    },
  );
});

describe("release provenance", () => {
  let fixture: string;
  let repository: string;
  let packagePath: string;
  let output: string;
  let commit: string;

  function git(args: string[]): string {
    return execFileSync(fixtureGit, [
      "-c", "user.name=Release Test",
      "-c", "user.email=release@example.invalid",
      "-c", `core.hooksPath=${join(fixture, "disabled-hooks")}`,
      "-c", "commit.gpgSign=false",
      ...args,
    ], { cwd: repository, encoding: "utf8" });
  }

  function packFixture(name = "@danskebank/mcp-api-proxy", packageVersion = version): void {
    writeFileSync(join(fixture, "package", "package.json"), JSON.stringify({
      name, version: packageVersion,
    }));
    execFileSync(fixtureTar, ["-czf", packagePath, "-C", fixture, "package"]);
  }

  function commitNotes(content: string): void {
    writeFileSync(join(repository, "RELEASE-NOTES.md"), content);
    git(["add", "RELEASE-NOTES.md"]);
    git(["commit", "--quiet", "-m", "Update fixture notes"]);
    commit = git(["rev-parse", "HEAD"]).trim();
  }

  function hash(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
    const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
    return spawnSync(process.execPath, ["--import", loader, script, ...args], {
      cwd: repository,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  beforeEach(() => {
    vi.stubEnv("PROVENANCE_GIT_EXECUTABLE", fixtureGit);
    vi.stubEnv("PROVENANCE_TAR_EXECUTABLE", fixtureTar);
    vi.stubEnv("PROVENANCE_TOOL_PATH", fixtureToolPath);
    fixture = mkdtempSync(join(tmpdir(), "proxy-release-test-"));
    repository = join(fixture, "repository");
    packagePath = join(fixture, "fixture.tgz");
    output = join(fixture, "evidence");
    mkdirSync(repository);
    mkdirSync(join(fixture, "package"));
    git(["init", "--quiet"]);
    writeFileSync(join(repository, "source.txt"), "committed source\n");
    git(["add", "source.txt"]);
    commitNotes(releaseNotes);
    packFixture();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  });

  it("adds internal evidence to plain committed release notes", () => {
    const publicNotes = "## Changes\n\n- Example release change.\n";
    commitNotes(publicNotes);

    createReleaseProvenance(packagePath, commit, output, repository);

    const notes = readFileSync(join(output, "RELEASE-NOTES.md"), "utf8");
    expect(notes).toContain(`# @danskebank/mcp-api-proxy ${version}`);
    expect(notes).toContain(commit);
    expect(notes).toContain(hash(join(output, `mcp-api-proxy-${version}.tgz`)));
    expect(notes).toContain(hash(join(output, `source-${version}.tar.gz`)));
    expect(notes).toContain(publicNotes);
    expect(git(["show", `${commit}:RELEASE-NOTES.md`])).toBe(publicNotes);
    expect(execFileSync(fixtureTar, [
      "-xOf", join(output, `source-${version}.tar.gz`), "RELEASE-NOTES.md",
    ], { encoding: "utf8" })).toBe(publicNotes);
  });

  it("records the exact tarball, committed source, release version and verifiable hashes", () => {
    writeFileSync(join(repository, "source.txt"), "uncommitted-source-sentinel\n");
    writeFileSync(join(repository, "RELEASE-NOTES.md"), "uncommitted-notes-sentinel\n");
    const originalPackage = readFileSync(packagePath);
    const originalStatus = git(["status", "--porcelain"]);

    expect(createReleaseProvenance(packagePath, "HEAD", output, repository)).toEqual({
      version, sourceCommit: commit,
    });

    const packageName = `mcp-api-proxy-${version}.tgz`;
    const sourceName = `source-${version}.tar.gz`;
    const notes = readFileSync(join(output, "RELEASE-NOTES.md"), "utf8");
    expect(notes).toContain(`# @danskebank/mcp-api-proxy ${version}`);
    expect(notes).toContain(commit);
    expect(notes).toContain(hash(join(output, packageName)));
    expect(notes).toContain(hash(join(output, sourceName)));
    expect(notes).toContain("## Known limits");
    expect(notes).toContain("## Feedback");
    expect(notes).toContain("https://developers.danskebank.com/premium-apis/contact-us");
    expect(notes).not.toContain("[Danske Bank Developer Portal](https://developers.danskebank.com)");
    expect(notes).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(notes).not.toContain("uncommitted");
    expect(readFileSync(join(output, packageName))).toEqual(originalPackage);
    expect(readFileSync(packagePath)).toEqual(originalPackage);
    expect(execFileSync(fixtureTar, [
      "-xOf", join(output, sourceName), "source.txt",
    ], { encoding: "utf8" })).toBe("committed source\n");
    expect(git(["status", "--porcelain"])).toBe(originalStatus);

    const sums = readFileSync(join(output, "SHA256SUMS"), "utf8").trim().split("\n");
    expect(sums).toHaveLength(3);
    for (const name of [packageName, sourceName, "RELEASE-NOTES.md"]) {
      expect(sums).toContain(`${hash(join(output, name))}  ${name}`);
    }
  });

  it.each([
    ["@example/other-package", version],
    ["@danskebank/mcp-api-proxy", "../../unsafe"],
    ["@danskebank/mcp-api-proxy", ""],
  ])("rejects invalid package identity or version: %s %s", (name, packageVersion) => {
    packFixture(name, packageVersion);
    expect(() => createReleaseProvenance(packagePath, "HEAD", output, repository)).toThrow();
    expect(existsSync(output)).toBe(false);
  });

  it("fails on an unknown source ref instead of recording a different commit", () => {
    expect(() => createReleaseProvenance(
      packagePath, "missing-source-ref", output, repository,
    )).toThrow();
    expect(existsSync(output)).toBe(false);
  });

  it.each(["", " \n\t\n"])("rejects empty release notes: %j", (content) => {
    commitNotes(content);
    expect(() => createReleaseProvenance(
      packagePath, commit, output, repository,
    )).toThrow("Release notes are empty.");
    expect(existsSync(output)).toBe(false);
  });

  it("requires release notes at the selected commit", () => {
    git(["rm", "RELEASE-NOTES.md"]);
    git(["commit", "--quiet", "-m", "Remove fixture notes"]);
    expect(() => createReleaseProvenance(
      packagePath, "HEAD", output, repository,
    )).toThrow();
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    "VERSION", "SOURCE_COMMIT", "SOURCE_SHA256", "PACKAGE_SHA256", "UNKNOWN_FIELD",
  ])("rejects unresolved %s placeholders", (token) => {
    commitNotes(`${releaseNotes}\n{{${token}}}\n`);
    expect(() => createReleaseProvenance(
      packagePath, commit, output, repository,
    )).toThrow("Release notes contain an unresolved placeholder.");
    expect(existsSync(output)).toBe(false);
  });

  it("does not overwrite an existing output directory", () => {
    mkdirSync(output);
    writeFileSync(join(output, "sentinel"), "keep this file");
    expect(() => createReleaseProvenance(
      packagePath, commit, output, repository,
    )).toThrow(/EEXIST/);
    expect(readFileSync(join(output, "sentinel"), "utf8")).toBe("keep this file");
    expect(existsSync(join(output, "SHA256SUMS"))).toBe(false);
  });

  it("runs the source CLI against isolated fixture artifacts without stdout", () => {
    const run = runCli([packagePath, commit, output]);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`Release provenance created for ${version} at ${commit}.`);
    expect(existsSync(join(output, "SHA256SUMS"))).toBe(true);
  });

  it("runs the CLI entry with plain notes from the selected repository", async () => {
    const argv = process.argv;
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(repository);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.argv = [process.execPath, script, packagePath, commit, output];
      vi.resetModules();
      await import("../scripts/release-provenance.js");
      expect(stderr).toHaveBeenCalledWith(
        `Release provenance created for ${version} at ${commit}.`,
      );
      expect(existsSync(join(output, "SHA256SUMS"))).toBe(true);
    } finally {
      process.argv = argv;
      cwd.mockRestore();
      stderr.mockRestore();
    }
  });

  it("rejects missing arguments in the CLI entry", async () => {
    const argv = process.argv;
    try {
      process.argv = [process.execPath, script];
      vi.resetModules();
      await expect(import("../scripts/release-provenance.js")).rejects.toThrow(
        "Usage: node --import tsx scripts/release-provenance.ts",
      );
    } finally {
      process.argv = argv;
    }
  });

  it("uses explicit executables and a trusted PATH for tools and their helpers", () => {
    const untrusted = join(fixture, "untrusted-bin");
    const marker = join(fixture, "helper-path");
    const compressor = join(fixture, "archive-helper.mjs");
    mkdirSync(untrusted);
    writeFileSync(compressor, [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { delimiter } from "node:path";',
      'import { gzipSync } from "node:zlib";',
      `const untrusted = ${JSON.stringify(untrusted)};`,
      `writeFileSync(${JSON.stringify(marker)},`,
      '  process.env.PATH?.split(delimiter).includes(untrusted) ? "untrusted" : "trusted");',
      "process.stdout.write(gzipSync(readFileSync(0)));",
    ].join("\n"));
    const quote = (path: string) => {
      const normalized = process.platform === "win32" ? path.replaceAll("\\", "/") : path;
      return `'${normalized.replaceAll("'", "'\\''")}'`;
    };
    git(["config", "tar.tar.gz.command", `${quote(process.execPath)} ${quote(compressor)}`]);
    vi.stubEnv("PATH", untrusted);
    vi.mocked(execFileSync).mockClear();

    expect(createReleaseProvenance(packagePath, commit, output, repository)).toEqual({
      version, sourceCommit: commit,
    });
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls.map((call) => call[0])).toEqual([
      fixtureTar, fixtureGit, fixtureGit, fixtureGit,
    ]);
    for (const call of calls) {
      expect(call[2]).toEqual(expect.objectContaining({
        env: expect.objectContaining({ PATH: fixtureToolPath }),
      }));
    }
    expect(readFileSync(marker, "utf8")).toBe("trusted");
    expect(existsSync(join(output, "SHA256SUMS"))).toBe(true);
  });

  it.each(["GIT", "TAR"])("requires the %s executable configuration before writing evidence", (tool) => {
    vi.stubEnv(`PROVENANCE_${tool}_EXECUTABLE`, undefined);
    expect(() => createReleaseProvenance(
      packagePath, commit, output, repository,
    )).toThrow(`PROVENANCE_${tool}_EXECUTABLE`);
    expect(existsSync(output)).toBe(false);
  });

  it.each(["GIT", "TAR"])("does not fall back to PATH when the configured %s tool is missing", (tool) => {
    vi.stubEnv(`PROVENANCE_${tool}_EXECUTABLE`, join(fixture, "missing-executable"));
    expect(() => createReleaseProvenance(
      packagePath, commit, output, repository,
    )).toThrow(/ENOENT/);
    expect(existsSync(output)).toBe(false);
  });

  it("runs the CLI without inheriting a PATH", () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "PATH") delete env[key];
    }
    const run = runCli([packagePath, commit, output], env);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(existsSync(join(output, "SHA256SUMS"))).toBe(true);
  });

  it("fails the CLI explicitly without release-tool configuration", () => {
    const env = { ...process.env };
    delete env.PROVENANCE_GIT_EXECUTABLE;
    const run = runCli([packagePath, commit, output], env);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("PROVENANCE_GIT_EXECUTABLE");
    expect(existsSync(output)).toBe(false);
  });

  it("fails explicitly when CLI arguments are missing", () => {
    const run = runCli([]);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Usage: node --import tsx scripts/release-provenance.ts");
    expect(existsSync(output)).toBe(false);
  });
});
