import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const packageSchema = z.object({
  name: z.literal("@danskebank/mcp-api-proxy"),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function resolveReleaseTools(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { git: string; tar: string; env: NodeJS.ProcessEnv } {
  const paths = platform === "win32" ? win32 : posix;
  const absolutePath = z.string().refine(
    (value) => paths.isAbsolute(value)
      && (platform !== "win32" || paths.parse(value).root.length > 1),
    "Use a fully qualified absolute path.",
  );
  const config = z.object({
    PROVENANCE_GIT_EXECUTABLE: absolutePath,
    PROVENANCE_TAR_EXECUTABLE: absolutePath,
    PROVENANCE_TOOL_PATH: z.string()
      .transform((value) => value.split(paths.delimiter))
      .pipe(z.array(absolutePath))
      .optional(),
  }).parse(environment);
  const directories = [
    paths.dirname(config.PROVENANCE_GIT_EXECUTABLE),
    paths.dirname(config.PROVENANCE_TAR_EXECUTABLE),
    ...(config.PROVENANCE_TOOL_PATH ?? []),
  ];
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  env.PATH = [...new Set(directories)].join(paths.delimiter);
  return {
    git: config.PROVENANCE_GIT_EXECUTABLE,
    tar: config.PROVENANCE_TAR_EXECUTABLE,
    env,
  };
}

export function createReleaseProvenance(
  packagePath: string,
  sourceRef: string,
  outputDirectory: string,
  repositoryDirectory = process.cwd(),
): { version: string; sourceCommit: string } {
  const tools = resolveReleaseTools();
  const packageFile = resolve(packagePath);
  const output = resolve(outputDirectory);
  const manifest = packageSchema.parse(JSON.parse(execFileSync(
    tools.tar, ["-xOf", packageFile, "package/package.json"],
    { encoding: "utf8", env: tools.env },
  )));
  const git = (args: string[]) => execFileSync(tools.git, args, {
    cwd: repositoryDirectory,
    encoding: "utf8",
    env: tools.env,
  });
  const sourceCommit = git([
    "rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`,
  ]).trim();
  const releaseNotes = git(["show", `${sourceCommit}:RELEASE-NOTES.md`]);
  if (!releaseNotes.trim()) {
    throw new Error("Release notes are empty.");
  }
  if (/\{\{[A-Z0-9_]+\}\}/.test(releaseNotes)) {
    throw new Error("Release notes contain an unresolved placeholder.");
  }

  mkdirSync(output);
  const packageName = `mcp-api-proxy-${manifest.version}.tgz`;
  const sourceName = `source-${manifest.version}.tar.gz`;
  copyFileSync(packageFile, join(output, packageName), constants.COPYFILE_EXCL);
  git(["archive", "--format=tar.gz", "--output", join(output, sourceName), sourceCommit]);

  const notes = [
    `# ${manifest.name} ${manifest.version}`,
    "",
    "## Provenance",
    "",
    `- Package version: \`${manifest.version}\``,
    `- Source commit: \`${sourceCommit}\``,
    `- Source archive SHA-256: \`${sha256(join(output, sourceName))}\``,
    `- npm package tarball SHA-256: \`${sha256(join(output, packageName))}\``,
    "",
    "The accompanying `SHA256SUMS` covers the exact package tarball, the committed",
    "source archive and these notes. Verify it with `sha256sum -c SHA256SUMS`",
    "(macOS: `shasum -a 256 -c SHA256SUMS`). These checksums identify artifacts;",
    "they are not a signature or a replacement for the trusted publishing channel.",
    "",
    releaseNotes.trimEnd(),
    "",
  ].join("\n");
  writeFileSync(join(output, "RELEASE-NOTES.md"), notes, { flag: "wx" });
  const checksums = [packageName, sourceName, "RELEASE-NOTES.md"]
    .map((name) => `${sha256(join(output, name))}  ${name}`)
    .join("\n");
  writeFileSync(join(output, "SHA256SUMS"), `${checksums}\n`, { flag: "wx" });
  return { version: manifest.version, sourceCommit };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    throw new Error(
      "Usage: node --import tsx scripts/release-provenance.ts <package.tgz> <source-ref> <new-output-directory>",
    );
  }
  const release = createReleaseProvenance(args[0], args[1], args[2]);
  console.error(`Release provenance created for ${release.version} at ${release.sourceCommit}.`);
}
