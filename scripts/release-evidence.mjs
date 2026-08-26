import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProductionBuild } from "./production-build.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function argumentsFrom(argv) {
  let output;
  let requireClean = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-clean") {
      if (requireClean) throw new Error("--require-clean may be supplied only once.");
      requireClean = true;
      continue;
    }
    if (argument === "--output") {
      if (output !== undefined) throw new Error("--output may be supplied only once.");
      output = argv[index + 1];
      if (!output || output.startsWith("--")) throw new Error("--output requires a file path.");
      index += 1;
      continue;
    }
    throw new Error(`Unknown release-evidence argument: ${argument}`);
  }
  return { output, requireClean };
}

export function collectReleaseEvidence({ root = resolve(process.cwd(), "dist") } = {}) {
  const files = inspectProductionBuild(root);
  const sourceCommit = git("rev-parse", "HEAD");
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Git did not return a full source commit.");
  const sourceTreeClean = git("status", "--porcelain", "--untracked-files=normal") === "";
  const packageLock = readFileSync(resolve(process.cwd(), "package-lock.json"));
  const packageLockSha256 = createHash("sha256").update(packageLock).digest("hex");
  const buildSha256 = createHash("sha256")
    .update(files.map((file) => `${file.sha256}  ${file.bytes}  ${file.path}\n`).join(""))
    .digest("hex");

  return {
    format: "wildbloom-release-evidence-v1",
    sourceCommit,
    sourceTreeClean,
    packageLockSha256,
    buildSha256,
    files,
  };
}

function run() {
  const options = argumentsFrom(process.argv.slice(2));
  const evidence = collectReleaseEvidence();
  if (options.requireClean && !evidence.sourceTreeClean) {
    throw new Error("Release evidence requires a clean tracked source tree.");
  }
  const payload = `${JSON.stringify(evidence, null, 2)}\n`;
  if (options.output === undefined) {
    process.stdout.write(payload);
    return;
  }
  const output = resolve(options.output);
  const buildRoot = resolve(process.cwd(), "dist");
  const fromBuildRoot = relative(buildRoot, output);
  if (
    fromBuildRoot === ""
    || (fromBuildRoot !== ".." && !fromBuildRoot.startsWith(`..${sep}`) && !isAbsolute(fromBuildRoot))
  ) {
    throw new Error("Release evidence must not be written into the public build directory.");
  }
  writeFileSync(output, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`Wrote release evidence to ${output}\n`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === resolve(fileURLToPath(import.meta.url))) run();
