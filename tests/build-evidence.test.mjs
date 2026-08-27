import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compareBuildEvidence } from "../scripts/compare-build-evidence.mjs";

const COMMIT = "ab".repeat(20);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function releaseEvidence({
  sourceCommit = COMMIT,
  packageLockSha256 = "cd".repeat(32),
  node = "v24.14.1",
  npm = "11.11.0",
  app = "app",
} = {}) {
  const files = [
    { path: "assets/app-abcdefgh.js", bytes: Buffer.byteLength(app), sha256: sha256(app) },
    { path: "index.html", bytes: 5, sha256: sha256("index") },
  ];
  return {
    format: "wildbloom-release-evidence-v2",
    sourceCommit,
    sourceTreeClean: true,
    packageLockSha256,
    buildToolchain: { node, npm },
    buildSha256: sha256(files.map((file) => `${file.sha256}  ${file.bytes}  ${file.path}\n`).join("")),
    files,
  };
}

describe("cross-platform build evidence", () => {
  it("accepts exact independently parsed evidence for one source commit", () => {
    const result = compareBuildEvidence([
      { label: "linux", evidence: releaseEvidence() },
      { label: "macos", evidence: releaseEvidence() },
      { label: "windows", evidence: releaseEvidence() },
    ], COMMIT);
    expect(result.labels).toEqual(["linux", "macos", "windows"]);
    expect(result.sourceCommit).toBe(COMMIT);
    expect(result.buildSha256).toBe(releaseEvidence().buildSha256);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.files)).toBe(true);
  });

  it("rejects byte, toolchain, package-lock and source drift", () => {
    const baseline = { label: "linux", evidence: releaseEvidence() };
    expect(() => compareBuildEvidence([
      baseline,
      { label: "windows", evidence: releaseEvidence({ app: "changed" }) },
    ], COMMIT)).toThrow(/buildSha256/u);
    expect(() => compareBuildEvidence([
      baseline,
      { label: "windows", evidence: releaseEvidence({ node: "v24.15.0" }) },
    ], COMMIT)).toThrow(/buildToolchain/u);
    expect(() => compareBuildEvidence([
      baseline,
      { label: "windows", evidence: releaseEvidence({ packageLockSha256: "ef".repeat(32) }) },
    ], COMMIT)).toThrow(/packageLockSha256/u);
    expect(() => compareBuildEvidence([
      baseline,
      { label: "windows", evidence: releaseEvidence({ sourceCommit: "12".repeat(20) }) },
    ], COMMIT)).toThrow(/different source commit/u);
  });

  it("rejects malformed, dirty, duplicate and ambiguously labelled evidence", () => {
    expect(() => compareBuildEvidence([
      { label: "linux", evidence: { ...releaseEvidence(), sourceTreeClean: false } },
      { label: "windows", evidence: releaseEvidence() },
    ], COMMIT)).toThrow(/clean source tree/u);
    expect(() => compareBuildEvidence([
      { label: "linux", evidence: releaseEvidence() },
      { label: "linux", evidence: releaseEvidence() },
    ], COMMIT)).toThrow(/duplicate label/u);
    expect(() => compareBuildEvidence([
      { label: "../linux", evidence: releaseEvidence() },
      { label: "windows", evidence: releaseEvidence() },
    ], COMMIT)).toThrow(/invalid label/u);
    expect(() => compareBuildEvidence([
      { label: "linux", evidence: releaseEvidence() },
      { label: "windows", evidence: releaseEvidence() },
    ], "main")).toThrow(/full expected commit/u);
  });

  it("compares bounded evidence files through the production CLI", () => {
    const temporary = mkdtempSync(join(tmpdir(), "wildbloom-build-evidence-"));
    const linux = join(temporary, "linux.json");
    const windows = join(temporary, "windows.json");
    try {
      writeFileSync(linux, JSON.stringify(releaseEvidence()));
      writeFileSync(windows, JSON.stringify(releaseEvidence()));
      const command = [
        "scripts/compare-build-evidence.mjs",
        "--expect-commit", COMMIT,
        "--input", `linux=${linux}`,
        "--input", `windows=${windows}`,
      ];
      const compared = spawnSync(process.execPath, command, { encoding: "utf8" });
      expect(compared.status).toBe(0);
      expect(compared.stdout).toMatch(/Cross-platform build evidence matched for linux, windows/u);

      const unknown = spawnSync(process.execPath, ["scripts/compare-build-evidence.mjs", "--inputs"], { encoding: "utf8" });
      expect(unknown.status).not.toBe(0);
      expect(unknown.stderr).toMatch(/Unknown build-comparison argument/u);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 20_000);
});
