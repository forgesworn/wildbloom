import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { challengeDigest } from "../src/core/storage-proof.js";
import { parseArguments, verifyStorageAudits } from "../scripts/verify-storage-audits.mjs";

const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "wildbloom-audit-evidence-"));
  dirs.push(dir);
  const bytes = Buffer.from("synthetic ciphertext fixture\0");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blob = join(dir, "ciphertext.bin");
  await writeFile(blob, bytes);
  const reports = [];
  for (let i = 1; i <= 2; i++) {
    const nonce = i.toString(16).padStart(64, "0");
    const report = { version: 1, scope: "full-read retrievability; no continuous-retention or dedicated-copy claim", failed: [], failures: [], proofs: [{
      version: 1, scope: "full-read retrievability", origin: "https://private-node.example/", sha256, size: bytes.length,
      nonce, digest: await challengeDigest(new Blob([bytes]), nonce), verifiedAt: 1800000000 + i,
    }] };
    const path = join(dir, `report-${i}.json`);
    await writeFile(path, JSON.stringify(report));
    reports.push(path);
  }
  return { blob, sha256, size: bytes.length, origin: "https://private-node.example/", reports, output: join(dir, "result.json") };
}
async function change(options, mutate) {
  const report = JSON.parse(await readFile(options.reports[1], "utf8"));
  mutate(report);
  await writeFile(options.reports[1], JSON.stringify(report));
}
describe("offline storage audit evidence", () => {
  it("independently verifies browser digests and redacts identifiers", async () => {
    const options = await fixture();
    const result = await verifyStorageAudits(options);
    expect(result).toMatchObject({ result: "saved-digests-verified", reportsVerified: 2, distinctChallenges: 2 });
    const output = JSON.stringify(result);
    for (const privateValue of [options.sha256, options.origin, options.blob, "1800000001"]) expect(output).not.toContain(privateValue);
    expect(result.limits).toContain("unsigned");
  });
  it.each(["nonce", "digest", "sha256", "size", "origin", "partial", "empty", "missing-failures", "scope"])("refuses %s mismatches", async (mode) => {
    const options = await fixture();
    await change(options, (report) => {
      if (mode === "partial") report.failed.push("https://private-node.example");
      else if (mode === "empty") report.proofs = [];
      else if (mode === "missing-failures") delete report.failures;
      else if (mode === "scope") report.scope = "other";
      else report.proofs[0][mode] = ({ nonce: "1".padStart(64, "0"), digest: "0".repeat(64), sha256: "0".repeat(64), size: 2, origin: "https://other.example/" })[mode];
    });
    await expect(verifyStorageAudits(options)).rejects.toThrow();
  });
  it("refuses ciphertext corruption even at the expected size", async () => {
    const options = await fixture();
    await writeFile(options.blob, Buffer.alloc(options.size));
    await expect(verifyStorageAudits(options)).rejects.toThrow("SHA-256");
  });
  it("bounds report reads and rejects malformed JSON", async () => {
    const options = await fixture();
    await writeFile(options.reports[0], "{" );
    await expect(verifyStorageAudits(options)).rejects.toThrow("valid JSON");
    await writeFile(options.reports[0], " ".repeat(65537));
    await expect(verifyStorageAudits(options)).rejects.toThrow("64 KiB");
  });
  it("writes a private result once and refuses to overwrite it", async () => {
    const options = await fixture();
    const args = ["--blob", options.blob, "--sha256", options.sha256, "--size", String(options.size), "--origin", options.origin, "--output", options.output,
      ...options.reports.flatMap((path) => ["--report", path])];
    expect(parseArguments(args)).toEqual(options);
    const run = () => execFileSync(process.execPath, ["scripts/verify-storage-audits.mjs", ...args], { encoding: "utf8", stdio: "pipe" });
    expect(run()).toContain("Verified 2");
    const original = await readFile(options.output, "utf8");
    expect(run).toThrow();
    expect(await readFile(options.output, "utf8")).toBe(original);
    for (const extra of [["--report", options.reports[0]], ["--unknown", "x"], ["--size", "-1"]]) expect(() => parseArguments([...args, ...extra])).toThrow();
  });
});
