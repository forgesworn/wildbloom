import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseEvidence, validateReleaseEvidence } from "./release-evidence-format.mjs";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const MAX_INPUTS = 8;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const inputs = [];
  let expectedCommit;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--expect-commit") {
      expect(expectedCommit === undefined, "--expect-commit may be supplied only once.");
      expectedCommit = argv[index + 1];
      expect(expectedCommit && !expectedCommit.startsWith("--"), "--expect-commit requires a full commit.");
      index += 1;
      continue;
    }
    if (argument === "--input") {
      const value = argv[index + 1];
      expect(value && !value.startsWith("--"), "--input requires label=path.");
      const separator = value.indexOf("=");
      expect(separator > 0 && separator < value.length - 1, "--input requires label=path.");
      inputs.push({ label: value.slice(0, separator), path: value.slice(separator + 1) });
      expect(inputs.length <= MAX_INPUTS, `Build comparison accepts at most ${MAX_INPUTS} inputs.`);
      index += 1;
      continue;
    }
    throw new Error(`Unknown build-comparison argument: ${argument}`);
  }
  expect(COMMIT.test(expectedCommit ?? ""), "Build comparison requires one full --expect-commit value.");
  expect(inputs.length >= 2, "Build comparison requires at least two inputs.");
  return { expectedCommit, inputs };
}

export function compareBuildEvidence(entries, expectedCommit) {
  expect(COMMIT.test(expectedCommit ?? ""), "Build comparison requires a full expected commit.");
  expect(Array.isArray(entries) && entries.length >= 2 && entries.length <= MAX_INPUTS, "Build comparison requires between two and eight inputs.");
  const labels = new Set();
  const validated = entries.map((entry) => {
    expect(entry && typeof entry === "object" && !Array.isArray(entry), "Build comparison received an invalid input.");
    expect(LABEL.test(entry.label ?? ""), `Build comparison received an invalid label: ${String(entry.label)}`);
    expect(!labels.has(entry.label), `Build comparison received a duplicate label: ${entry.label}`);
    labels.add(entry.label);
    return { label: entry.label, evidence: validateReleaseEvidence(entry.evidence) };
  });

  const baseline = validated[0];
  expect(baseline.evidence.sourceCommit === expectedCommit, `${baseline.label} build evidence describes a different source commit.`);
  const comparableFields = ["sourceCommit", "packageLockSha256", "buildToolchain", "buildSha256", "files"];
  for (const candidate of validated.slice(1)) {
    expect(candidate.evidence.sourceCommit === expectedCommit, `${candidate.label} build evidence describes a different source commit.`);
    for (const field of comparableFields) {
      expect(
        JSON.stringify(candidate.evidence[field]) === JSON.stringify(baseline.evidence[field]),
        `${candidate.label} build evidence differs from ${baseline.label} at ${field}.`,
      );
    }
  }
  return Object.freeze({
    labels: Object.freeze(validated.map((entry) => entry.label)),
    sourceCommit: baseline.evidence.sourceCommit,
    packageLockSha256: baseline.evidence.packageLockSha256,
    buildToolchain: baseline.evidence.buildToolchain,
    buildSha256: baseline.evidence.buildSha256,
    files: baseline.evidence.files,
  });
}

function run() {
  const options = parseArguments(process.argv.slice(2));
  const entries = options.inputs.map((input) => ({
    label: input.label,
    evidence: readReleaseEvidence(input.path),
  }));
  const result = compareBuildEvidence(entries, options.expectedCommit);
  process.stdout.write(
    `Cross-platform build evidence matched for ${result.labels.join(", ")}: ${result.files.length} exact files (${result.buildSha256}) from ${result.sourceCommit}.\n`,
  );
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === resolve(fileURLToPath(import.meta.url))) run();
