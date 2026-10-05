import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProductionBuild } from "./production-build.mjs";
import { assertNoBrowserPersistence } from "./browser-persistence.mjs";

// Uses only the disposable nodes/receipt created by pool-acceptance.mjs.
export async function acceptQuickPoolRecovery(h) {
  const { root, binary, nodes, origin, allowed, publisher, browser, browserName,
    source, key, receiptBytes, receiptPath, event, manifest, owner, children,
    errors, launch, stop, ready, pageAt, status, hash } = h;
  const started = Date.now();
  const evidence = {
    schema: "wildbloom.quick-pool-recovery.v1", passed: false,
    scope: "single-host independent processes over loopback; not physical-device acceptance",
    started_at: new Date(started).toISOString(), platform: process.platform,
    node_version: process.version, browser: browserName, browser_version: browser.version(),
    daemon_sha256: hash(readFileSync(binary)),
    source_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    source_dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    production_build_sha256: hash(Buffer.from(loadProductionBuild("dist")
      .map((file) => `${file.sha256}  ${file.bytes}  ${file.path}\n`).join(""))),
    harness_sha256: hash(Buffer.concat([readFileSync("scripts/pool-acceptance.mjs"),
      readFileSync("scripts/pool-quick-acceptance.mjs")])),
    fixture_bytes: source.length, fixture_sha256: hash(source),
    layout: { required: manifest.required, total: manifest.total, nodes: nodes.length }, checks: [],
  };
  function passed(check) {
    evidence.checks.push(check);
    process.stdout.write(`PASS ${check}\n`);
  }
  const dataParts = manifest.parts.slice(0, 2), parityParts = manifest.parts.slice(2);
  const nodeFor = (part, target = 0) => nodes.find((node) => `${node.origin}/` === part.targets[target].origin);
  const readPart = async (part, target = 0) => {
    const response = await fetch(`${part.targets[target].origin}${part.sha256}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, part.size); assert.equal(hash(bytes), part.sha256);
  };
  async function recover(label) {
    const fresh = await pageAt(origin, allowed), page = fresh.page;
    try {
      await page.getByText("Use a saved signed event without a relay", { exact: true }).click();
      await page.fill("#saved-event-json", receiptBytes.toString());
      await page.click("#verify-saved-event");
      await status(page, "#retrieve-status", "Pool receipt verified locally");
      await page.fill("#recovery-key-input", key); await page.click("#fetch-blossom");
      await status(page, "#retrieve-status", "reconstructed ciphertext and AES-GCM");
      const download = page.waitForEvent("download");
      await page.getByRole("link", { name: "Save verified pool-proof.bin" }).click();
      assert.deepEqual(readFileSync(await (await download).path()), source);
      await assertNoBrowserPersistence(page, fresh.context, label);
      passed(label);
    } finally { await fresh.context.close(); }
  }
  const signerPath = join(root, "quick-synthetic-signer.mjs");
  writeFileSync(signerPath, `import { finalizeEvent } from ${JSON.stringify(import.meta.resolve("nostr-tools/pure"))};
let input = ""; for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify(finalizeEvent(JSON.parse(input), new Uint8Array(32).fill(37))));`, { mode: 0o600 });
  const args = ["replicas", "pool-repair", "--receipt", receiptPath, "--receipt-id", event.id,
    "--owner", owner, "--work-dir", join(root, "quick-owner"), "--allow-reconstruction",
    "--expires-at", String(Math.floor(Date.now() / 1000) + 180),
    "--transfer-budget-bytes", String(64 * 1024 * 1024), "--max-work-bytes", String(32 * 1024 * 1024),
    "--signer", process.execPath, `--signer-arg=${signerPath}`, "--permit-loopback-development"];
  let resident;
  try {
    for (const part of manifest.parts) await readPart(part);
    passed("all four initial parts verified by independent GET/hash");
    for (const part of dataParts) await stop(nodeFor(part).child);
    await assertNoBrowserPersistence(publisher.page, publisher.context, "quick publisher");
    await publisher.context.close();
    await recover("fresh-browser recovery with both data nodes offline (parity only)");

    // No browser context or recovery key is supplied to the owner service.
    resident = spawn(binary, [...args, "--interval", "5"], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(resident);
    const reports = [];
    let pending = "", processError;
    resident.on("error", (error) => { processError = error; });
    resident.stdout.on("data", (chunk) => {
      pending += chunk;
      if (pending.length > 1024 * 1024) { processError = new Error("Oversized repair report"); resident.kill(); return; }
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        try { reports.push(JSON.parse(pending.slice(0, end))); }
        catch { processError = new Error("Invalid repair report"); }
        pending = pending.slice(end + 1);
      }
    });
    async function waitReport(after, predicate) {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (processError) throw processError;
        assert.equal(resident.exitCode, null, "Owner service exited early");
        assert.equal(resident.signalCode, null, "Owner service was killed");
        const report = reports.slice(after).find(predicate);
        if (report) return report;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Timed out waiting for a new automatic repair pass");
    }
    const repaired = (report) => report.reconstructed && report.protected &&
      report.recoverable && report.uploads_attempted >= 1 &&
      report.verified_groups.length === 4 && report.verified_groups.every((count) => count >= 1);
    await waitReport(0, repaired);
    for (const part of dataParts) await readPart(part, 1);
    for (const part of parityParts) await readPart(part);
    passed("owner service automatically rebuilt both data parts onto approved spares; four parts verified");

    // A later, different loss must be detected by the already-running service.
    const reportsBeforeLoss = reports.length;
    for (const part of parityParts) await stop(nodeFor(part).child);
    for (const part of parityParts) {
      const node = nodeFor(part);
      node.child = launch(binary, ["--no-tor", "--bind", new URL(node.origin).host,
        "--public-url", node.origin, "--allow-pubkey", owner,
        "--data-dir", join(root, `quick-empty-${part.index}`), "--repair-interval", "0"]);
      await ready(node.child, node.origin);
    }
    // Require a report emitted after the first repair. Direct GET below proves
    // the replacement stores actually contain their exact newly restored parts.
    await waitReport(reportsBeforeLoss, repaired);
    for (const part of parityParts) await readPart(part);
    for (const part of dataParts) await readPart(part, 1);
    passed("same resident service detected later empty parity stores and restored all four parts");
    await stop(resident);
    for (const part of dataParts) await stop(nodeFor(part, 1).child);
    await recover("fresh-browser recovery using only automatically regenerated parity parts");

    // Below k, an actual repair attempt must fail safely without any uploads.
    await stop(nodeFor(parityParts[0]).child);
    const check = spawn(binary, [...args, "--once"], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(check);
    let output = "";
    check.stdout.on("data", (chunk) => { output += chunk; if (output.length > 1024 * 1024) check.kill(); });
    const timer = setTimeout(() => check.kill("SIGKILL"), 15000);
    let code;
    try { [code] = await once(check, "exit"); } finally { clearTimeout(timer); }
    assert.notEqual(code, 0);
    const report = JSON.parse(output);
    assert.equal(report.recoverable, false); assert.equal(report.protected, false);
    assert.equal(report.reconstructed, false); assert.equal(report.uploads_attempted, 0);
    passed("below-threshold repair refused reconstruction and attempted zero uploads");
    assert.deepEqual(errors, []);
    evidence.passed = true;
  } finally {
    if (resident) await stop(resident);
    evidence.duration_ms = Date.now() - started;
    const evidencePath = process.env.WILDBLOOM_POOL_EVIDENCE;
    if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`Quick recovery passed in ${(evidence.duration_ms / 1000).toFixed(1)}s after upload. Six local node processes; physical device/network failures remain untested.\n`);
}
