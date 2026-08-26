import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isProductionAssetPath,
  MAX_PRODUCTION_BUILD_BYTES,
  MAX_PRODUCTION_FILE_BYTES,
  MAX_PRODUCTION_FILES,
} from "./production-build.mjs";

const HEX_64 = /^[0-9a-f]{64}$/u;
const HEX_40 = /^[0-9a-f]{40}$/u;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function objectKeys(value) {
  return Object.keys(value).sort().join(",");
}

export function validateReleaseEvidence(value) {
  expect(value && typeof value === "object" && !Array.isArray(value), "Release evidence must be a JSON object.");
  expect(
    objectKeys(value) === "buildSha256,buildToolchain,files,format,packageLockSha256,sourceCommit,sourceTreeClean",
    "Release evidence has an unexpected top-level shape.",
  );
  expect(value.format === "wildbloom-release-evidence-v2", "Release evidence has an unsupported format.");
  expect(HEX_40.test(value.sourceCommit), "Release evidence has an invalid source commit.");
  expect(value.sourceTreeClean === true, "Release evidence must attest a clean source tree.");
  expect(HEX_64.test(value.packageLockSha256), "Release evidence has an invalid package-lock hash.");
  expect(
    value.buildToolchain && typeof value.buildToolchain === "object" && !Array.isArray(value.buildToolchain)
      && objectKeys(value.buildToolchain) === "node,npm",
    "Release evidence has an invalid build toolchain shape.",
  );
  expect(/^v24\.[0-9]+\.[0-9]+$/u.test(value.buildToolchain.node), "Release evidence has an unsupported Node build version.");
  expect(/^11\.[0-9]+\.[0-9]+$/u.test(value.buildToolchain.npm), "Release evidence has an unsupported npm build version.");
  expect(HEX_64.test(value.buildSha256), "Release evidence has an invalid aggregate build hash.");
  expect(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= MAX_PRODUCTION_FILES, "Release evidence has an invalid file list.");

  const paths = new Set();
  let buildBytes = 0;
  for (const file of value.files) {
    expect(file && typeof file === "object" && !Array.isArray(file), "Release evidence contains an invalid file entry.");
    expect(objectKeys(file) === "bytes,path,sha256", "Release evidence file entry has an unexpected shape.");
    expect(file.path === "index.html" || isProductionAssetPath(file.path), `Release evidence contains an unsafe file path: ${String(file.path)}`);
    expect(!paths.has(file.path), `Release evidence contains a duplicate file path: ${file.path}`);
    expect(
      Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_PRODUCTION_FILE_BYTES,
      `Release evidence has an invalid or excessive byte count: ${file.path}`,
    );
    expect(HEX_64.test(file.sha256), `Release evidence has an invalid file hash: ${file.path}`);
    buildBytes += file.bytes;
    paths.add(file.path);
  }
  expect(buildBytes <= MAX_PRODUCTION_BUILD_BYTES, "Release evidence exceeds the deployment verification byte budget.");
  expect(paths.has("index.html"), "Release evidence does not contain index.html.");
  expect(
    JSON.stringify(value.files.map((file) => file.path))
      === JSON.stringify([...value.files.map((file) => file.path)].sort()),
    "Release evidence file paths are not canonical.",
  );
  const aggregate = createHash("sha256")
    .update(value.files.map((file) => `${file.sha256}  ${file.bytes}  ${file.path}\n`).join(""))
    .digest("hex");
  expect(aggregate === value.buildSha256, "Release evidence aggregate build hash is inconsistent.");
  return Object.freeze({
    format: value.format,
    sourceCommit: value.sourceCommit,
    sourceTreeClean: value.sourceTreeClean,
    packageLockSha256: value.packageLockSha256,
    buildToolchain: Object.freeze({ ...value.buildToolchain }),
    buildSha256: value.buildSha256,
    files: Object.freeze(value.files.map((file) => Object.freeze({ ...file }))),
  });
}

export function readReleaseEvidence(path) {
  const absolute = resolve(path);
  const details = lstatSync(absolute);
  expect(details.isFile() && !details.isSymbolicLink(), "Release evidence must be a regular file, not a symbolic link.");
  expect(details.size > 0 && details.size <= MAX_EVIDENCE_BYTES, "Release evidence file has an unsafe size.");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new Error("Release evidence is not valid JSON.");
  }
  return validateReleaseEvidence(parsed);
}
