import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { chromium, firefox, webkit } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { assertNoBrowserPersistence, installBrowserPersistenceAudit } from "./browser-persistence.mjs";

// Synthetic signer remains in the harness. No signing key enters the browser.
const secret = new Uint8Array(32).fill(37);
const owner = getPublicKey(secret);
const binary = process.env.WILDBLOOM_NODE_BIN;
if (!binary) throw new Error("Set WILDBLOOM_NODE_BIN to the reviewed daemon binary.");
const quick = process.argv.includes("--quick");
if (quick && (process.argv.includes("--maximum") || process.argv.includes("--tor"))) {
  throw new Error("Quick recovery is a small loopback test; use the full suite for --maximum or --tor.");
}
const root = mkdtempSync(join(tmpdir(), "wildbloom-pool-"));
const children = [];
const contexts = [];
const errors = [];
const stoppedOrigins = new Set();
const maximum = process.argv.includes("--maximum");
const source = Buffer.alloc(maximum ? 256 * 1024 * 1024 : 1024 * 1024 + 19, 91);
const operationTimeout = maximum ? 10 * 60 * 1000 : 60000;
const browserName = process.env.WILDBLOOM_BROWSER ?? "system-chromium";
if (!["system-chromium", "chromium", "firefox", "webkit"].includes(browserName)) throw new Error("Unsupported browser");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let browser;
async function port() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve)); return result;
}
function launch(command, args) {
  const child = spawn(command, args, { stdio: "ignore" });
  child.on("error", () => errors.push("Child process failed")); children.push(child); return child;
}
async function stop(child) {
  if (child.poolOrigin) stoppedOrigins.add(child.poolOrigin);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, "exit"); child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await done; } finally { clearTimeout(timeout); }
}
async function ready(child, origin) {
  child.poolOrigin = origin; stoppedOrigins.delete(origin);
  for (let attempt = 0; attempt < 200; attempt++) {
    assert.equal(child.exitCode, null);
    try { if ((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Node failed to become ready");
}
async function status(page, selector, text) {
  await page.locator(selector).filter({ hasText: text }).waitFor({ timeout: operationTimeout });
  if (maximum) process.stdout.write(`Maximum-file milestone: ${text}\n`);
}
async function signUntil(page, selector, completed) {
  const deadline = Date.now() + operationTimeout;
  while (Date.now() < deadline) {
    const message = await page.textContent(selector);
    if (message.includes(completed)) { if (maximum) process.stdout.write(`Maximum-file milestone: ${completed}\n`); return; }
    if (message.includes("Storage deficit:")) throw new Error(message);
    if (await page.locator("#external-signing-panel").isVisible()) {
      const json = await page.inputValue("#external-unsigned-event");
      await page.fill("#external-signed-event", JSON.stringify(finalizeEvent(JSON.parse(json), secret)));
      await page.click("#accept-external-signature");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Pool operation did not finish: ${await page.textContent(selector)}`);
}
async function externalSigner(page) {
  await page.check('input[name="signing-method"][value="external"]');
  await page.fill("#external-signer-pubkey", owner);
  await page.click("#connect-signer");
}
async function pageAt(origin, allowed) {
  const context = await browser.newContext({ acceptDownloads: true }); contexts.push(context);
  await context.addInitScript(installBrowserPersistenceAudit);
  await context.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", { value: class { constructor() { throw new Error("Unexpected peer connection"); } } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(maximum ? 120000 : 15000);
  const requests = [];
  page.on("pageerror", (error) => {
    // WebKit emits this engine-level error for an intentionally stopped node's
    // failed CORS preflight, even when fetch is caught by the application.
    const refused = /^\/(127\.0\.0\.1:\d+)\/upload due to access control checks\.$/u.exec(error.message);
    if (browserName === "webkit" && refused && stoppedOrigins.has(`http://${refused[1]}`)) return;
    errors.push(error.message);
  });
  page.on("websocket", () => errors.push("Unexpected relay/tracker"));
  if (maximum) {
    // Intercepting 128–256 MiB POST bodies copies them through Playwright's
    // protocol and measures the harness, not the app. Observe destinations;
    // the small-file suite separately enforces the blocking route boundary.
    page.on("request", (request) => {
      const url = new URL(request.url()); requests.push(url.href);
      if (!allowed.has(url.origin)) errors.push("Undeclared origin");
    });
  } else {
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url()); requests.push(url.href);
      if (!allowed.has(url.origin)) { errors.push("Undeclared origin"); await route.abort(); }
      else await route.continue();
    });
  }
  await page.goto(`${origin}/#client`);
  assert.ok(requests.every((url) => new URL(url).origin === origin));
  return { page, context, requests };
}
try {
  const nodes = [];
  for (let i = 0; i < 6; i++) {
    const origin = `http://127.0.0.1:${await port()}`;
    const child = launch(binary, ["--no-tor", "--bind", new URL(origin).host, "--public-url", origin,
      "--allow-pubkey", owner, "--data-dir", join(root, `node-${i}`), "--repair-interval", "0"]);
    await ready(child, origin); nodes.push({ origin, child });
  }
  const origin = `http://127.0.0.1:${await port()}`;
  const app = launch(process.execPath, ["scripts/serve-production.mjs", "--port", new URL(origin).port]);
  await ready(app, origin);
  browser = await (browserName === "firefox" ? firefox : browserName === "webkit" ? webkit : chromium).launch({ headless: true,
    ...(browserName === "system-chromium" ? { executablePath: process.env.WILDBLOOM_BROWSER_EXECUTABLE
      ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : process.platform === "win32" ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : "/usr/bin/google-chrome") } : {}) });
  const allowed = new Set([origin, ...nodes.map((node) => node.origin)]);
  const publisher = await pageAt(origin, allowed), p = publisher.page;
  await p.selectOption("#storage-mode", "erasure");
  await p.fill("#pool-nodes", nodes.map((node, i) => `${node.origin} site-${i} 1`).join("\n"));
  await externalSigner(p);
  writeFileSync(join(root, "pool-proof.bin"), source, { mode: 0o600 });
  await p.setInputFiles("#publish-file", join(root, "pool-proof.bin"));
  await p.click("#inspect-file");
  await status(p, "#publish-status", "Encrypted transfer payload prepared");
  const key = await p.inputValue("#recovery-key-output");
  assert.ok(await p.isDisabled("#protect-file"));
  await p.check("#key-saved-consent"); await p.check("#upload-consent");
  await p.click("#upload-file");
  await signUntil(p, "#publish-status", "Requested layout verified");
  const saving = p.waitForEvent("download"); await p.locator("#signed-event-links a").click();
  const receiptBytes = readFileSync(await (await saving).path());
  const event = JSON.parse(receiptBytes.toString()), manifest = JSON.parse(event.content);
  assert.equal(manifest.required, 2); assert.equal(manifest.total, 4);
  assert.ok(!receiptBytes.includes(Buffer.from(key)) && !receiptBytes.includes(Buffer.from("pool-proof.bin")));
  assert.ok(await p.isDisabled("#sign-events")); assert.ok(await p.isDisabled("#publish-events"));
  const violations = (await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations;
  assert.deepEqual(violations, []);
  const receiptPath = join(root, "receipt.json"); writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
  const templates = spawnSync(binary, ["replicas", "pool-template", "--receipt", receiptPath, "--owner", owner,
    "--revision", "1", "--expires-at", String(Math.floor(Date.now() / 1000) + 3600), "--permit-loopback-development"], { encoding: "utf8" });
  assert.equal(templates.status, 0, templates.stderr);
  const imported = JSON.parse(templates.stdout);
  assert.equal(imported.reconstructs_ciphertext, false); assert.equal(imported.unsigned_policies.length, 4);
  for (let i = 0; i < 4; i++) {
    const policy = JSON.parse(imported.unsigned_policies[i].content);
    assert.deepEqual(policy.blobs, [{ sha256: manifest.parts[i].sha256, size: manifest.parts[i].size }]);
  }
  for (const node of nodes) assert.equal((await fetch(`${node.origin}/${manifest.payload.sha256}`)).status, 404, "No node may hold the whole ciphertext");
  if (quick) {
    const { acceptQuickPoolRecovery } = await import("./pool-quick-acceptance.mjs");
    await acceptQuickPoolRecovery({ root, binary, nodes, origin, allowed, publisher, browser,
      browserName, source, key, receiptBytes, receiptPath, event, manifest, owner,
      children, errors, launch, stop, ready, pageAt, status, hash });
  } else {
  // Lose both systematic data parts: recovery now requires both parity parts.
  for (const part of manifest.parts.slice(0, 2)) await stop(nodes.find((node) => `${node.origin}/` === part.targets[0].origin).child);
  await assertNoBrowserPersistence(p, publisher.context, "pool publisher");
  await publisher.context.close();
  const fresh = await pageAt(origin, allowed), r = fresh.page;
  await r.getByText("Use a saved file event or pool receipt", { exact: true }).click();
  await r.fill("#saved-event-json", receiptBytes.toString());
  const before = fresh.requests.length;
  await r.click("#verify-saved-event");
  await status(r, "#retrieve-status", "Pool receipt verified locally");
  assert.equal(fresh.requests.length, before, "Receipt validation is local");
  await r.fill("#recovery-key-input", `wbk1_${Buffer.alloc(32, 99).toString("base64url")}`);
  await r.click("#fetch-blossom"); await r.locator("#retrieve-status.error").waitFor();
  assert.equal(await r.locator("#retrieve-links a").count(), 0);
  await r.fill("#recovery-key-input", key); await r.click("#fetch-blossom");
  await status(r, "#retrieve-status", "reconstructed ciphertext and AES-GCM");
  const download = r.waitForEvent("download"); await r.getByRole("link", { name: "Save verified pool-proof.bin" }).click();
  assert.equal(hash(readFileSync(await (await download).path())), hash(source));
  // Repair needs the owner signer, but no decryption key. Missing data parts
  // regenerate in the client and go only to their pre-approved spare nodes.
  await externalSigner(r); await r.check("#pool-repair-consent"); await r.click("#repair-pool");
  await signUntil(r, "#retrieve-status", "Requested layout verified");
  assert.equal(await r.inputValue("#recovery-key-input"), "");
  for (const part of manifest.parts.slice(0, 2)) {
    const response = await fetch(`${part.targets[1].origin}${part.sha256}`);
    assert.equal(response.status, 200); assert.equal(hash(Buffer.from(await response.arrayBuffer())), part.sha256);
  }
  // Drop the parity nodes too: recovered data parts must now carry the file.
  for (const part of manifest.parts.slice(2)) await stop(nodes.find((node) => `${node.origin}/` === part.targets[0].origin).child);
  await r.fill("#recovery-key-input", key); await r.click("#fetch-blossom");
  await status(r, "#retrieve-status", "reconstructed ciphertext and AES-GCM");
  // Add explicit replacements for the lost parity nodes, retaining all old
  // assignments in the newly signed receipt. New node origins are allowed only
  // after their selection here, never through implicit discovery.
  const replacements = [];
  for (let i = 0; i < 2; i++) {
    const replacementOrigin = `http://127.0.0.1:${await port()}`;
    const child = launch(binary, ["--no-tor", "--bind", new URL(replacementOrigin).host, "--public-url", replacementOrigin,
      "--allow-pubkey", owner, "--data-dir", join(root, `replacement-${i}`), "--repair-interval", "0"]);
    await ready(child, replacementOrigin);
    allowed.add(replacementOrigin); replacements.push({ origin: replacementOrigin, child });
  }
  await r.fill("#pool-replacements", replacements.map((node, i) => `${i + 3} ${node.origin} replacement-site-${i}`).join("\n"));
  assert.equal(await r.isChecked("#pool-repair-consent"), false);
  await r.check("#pool-repair-consent"); await r.click("#repair-pool");
  await signUntil(r, "#retrieve-status", "Requested layout verified");
  const replacementSaving = r.waitForEvent("download"); await r.locator("#resolved-event-links a").click();
  const replacementReceiptBytes = readFileSync(await (await replacementSaving).path());
  const replacementReceipt = JSON.parse(replacementReceiptBytes.toString());
  const replacementManifest = JSON.parse(replacementReceipt.content);
  assert.notEqual(replacementReceipt.id, event.id);
  for (let i = 0; i < 4; i++) assert.deepEqual(replacementManifest.parts[i].targets.slice(0, manifest.parts[i].targets.length), manifest.parts[i].targets);
  // Now only the two newly selected parity replacements need survive.
  for (const node of nodes) await stop(node.child);
  await r.fill("#recovery-key-input", key); await r.click("#fetch-blossom");
  await status(r, "#retrieve-status", "reconstructed ciphertext and AES-GCM");
  const savedAgain = r.waitForEvent("download"); await r.getByRole("link", { name: "Save verified pool-proof.bin" }).click();
  assert.equal(hash(readFileSync(await (await savedAgain).path())), hash(source));
  // Exercise the complete-copy choice in the production UI as well.
  await r.selectOption("#storage-mode", "replicas");
  await r.fill("#pool-nodes", replacements.map((node, i) => `${node.origin} replica-site-${i}`).join("\n"));
  writeFileSync(join(root, "replica-proof.bin"), source, { mode: 0o600 });
  await r.setInputFiles("#publish-file", join(root, "replica-proof.bin"));
  await r.click("#inspect-file"); await status(r, "#publish-status", "Encrypted transfer payload prepared");
  await r.check("#key-saved-consent"); await r.check("#upload-consent"); await r.click("#upload-file");
  await signUntil(r, "#publish-status", "Requested layout verified");
  assert.match(await r.textContent("#publish-status"), /copies per part: 2/u);
  // An unrelated file selection revokes a pending pool-repair signature too.
  await r.fill("#saved-event-json", replacementReceiptBytes.toString());
  await r.click("#verify-saved-event"); await status(r, "#retrieve-status", "Pool receipt verified locally");
  await r.check("#pool-repair-consent"); await r.click("#repair-pool");
  await r.locator("#external-signing-panel").waitFor({ state: "visible" });
  const requestsAtCancellation = fresh.requests.length;
  await r.setInputFiles("#publish-file", { name: "changed.bin", mimeType: "application/octet-stream", buffer: Buffer.from("changed source") });
  await r.locator("#external-signing-panel").waitFor({ state: "hidden" });
  await r.waitForTimeout(150);
  assert.equal(await r.isChecked("#pool-repair-consent"), false);
  assert.equal(fresh.requests.length, requestsAtCancellation, "File change cannot continue a pending repair");
  await assertNoBrowserPersistence(r, fresh.context, "pool recovery");
  await fresh.context.close();
  // No browser is open during native owner repair. Both systematic parts have
  // lost every live copy. Return their approved spare endpoints with empty disks.
  for (const part of replacementManifest.parts.slice(0, 2)) {
    const node = nodes.find((node) => `${node.origin}/` === part.targets[1].origin);
    node.child = launch(binary, ["--no-tor", "--bind", new URL(node.origin).host, "--public-url", node.origin,
      "--allow-pubkey", owner, "--data-dir", join(root, `empty-owner-${part.index}`), "--repair-interval", "0"]);
    await ready(node.child, node.origin);
  }
  const repairReceiptPath = join(root, "owner-receipt.json");
  writeFileSync(repairReceiptPath, replacementReceiptBytes, { mode: 0o600 });
  const signerPath = join(root, "synthetic-signer.mjs");
  writeFileSync(signerPath, `import { finalizeEvent } from ${JSON.stringify(import.meta.resolve("nostr-tools/pure"))};
import { writeFileSync } from "node:fs";
let input = ""; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (process.argv.includes("--wrong")) request.content = "wrong exact request";
if (process.argv.includes("--change")) writeFileSync(process.argv.at(-1), "changed receipt");
process.stdout.write(JSON.stringify(finalizeEvent(request, new Uint8Array(32).fill(37))));`, { mode: 0o600 });
  const work = join(root, "owner-work");
  const repairArgs = ["replicas", "pool-repair", "--receipt", repairReceiptPath, "--receipt-id", replacementReceipt.id,
    "--owner", owner, "--work-dir", work, "--allow-reconstruction", "--expires-at", String(Math.floor(Date.now() / 1000) + 1800),
    "--signer", process.execPath, `--signer-arg=${signerPath}`, "--permit-loopback-development"];
  async function native(args, timeout = operationTimeout) {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; assert.ok(stdout.length < 1024 * 1024); });
    child.stderr.on("data", (data) => { stderr += data; assert.ok(stderr.length < 1024 * 1024); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    try { const [code] = await once(child, "exit"); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); }
  }
  const lostParity = replacements[0]; await stop(lostParity.child);
  const insufficient = await native([...repairArgs, "--once"]);
  assert.notEqual(insufficient.code, 0);
  assert.equal(JSON.parse(insufficient.stdout).recoverable, false);
  assert.equal(JSON.parse(insufficient.stdout).uploads_attempted, 0);
  lostParity.child = launch(binary, ["--no-tor", "--bind", new URL(lostParity.origin).host, "--public-url", lostParity.origin,
    "--allow-pubkey", owner, "--data-dir", join(root, "replacement-0"), "--repair-interval", "0"]);
  await ready(lostParity.child, lostParity.origin);
  for (const limit of ["--transfer-budget-bytes", "--max-work-bytes"]) {
    const refused = await native([...repairArgs, "--once", limit, "0"]);
    assert.notEqual(refused.code, 0); assert.equal(refused.stdout, "");
  }
  const changed = await native([...repairArgs, "--once", "--signer-arg=--change", `--signer-arg=${repairReceiptPath}`]);
  assert.notEqual(changed.code, 0); assert.match(changed.stderr, /policy changed during the maintenance pass/u);
  assert.equal(changed.stdout, "", "Changed receipt cannot complete an authorised pass");
  writeFileSync(repairReceiptPath, replacementReceiptBytes, { mode: 0o600 });
  const wrong = await native([...repairArgs, "--once", "--signer-arg=--wrong"]);
  assert.notEqual(wrong.code, 0);
  assert.equal(JSON.parse(wrong.stdout).uploads_attempted, 0, "Changed signer return cannot authorise an upload");
  const repaired = await native([...repairArgs, "--once"]);
  assert.equal(repaired.code, 0, repaired.stderr);
  const ownerReport = JSON.parse(repaired.stdout);
  assert.equal(ownerReport.reconstructed, true); assert.equal(ownerReport.protected, true);
  for (const part of replacementManifest.parts.slice(0, 2)) {
    const response = await fetch(`${part.targets[1].origin}${part.sha256}`);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), part.sha256);
    assert.equal((await fetch(`${part.targets[1].origin}${replacementManifest.payload.sha256}`)).status, 404);
  }
  const restarted = await native([...repairArgs, "--once"]);
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.equal(JSON.parse(restarted.stdout).uploads_attempted, 0);
  assert.equal(JSON.parse(restarted.stdout).reconstructed, false);
  // The resident service notices a later loss and repairs on its next pass.
  const resident = spawn(binary, [...repairArgs, "--interval", "5"], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(resident);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Resident did not finish its first pass")), operationTimeout);
    resident.once("exit", () => { clearTimeout(timer); reject(new Error("Resident exited before first pass")); });
    resident.stdout.once("data", () => { clearTimeout(timer); resolve(); });
  });
  resident.stdout.resume();
  const locked = await native([...repairArgs, "--once"]);
  assert.notEqual(locked.code, 0); assert.match(locked.stderr, /another coordinator already owns this replica state directory/u);
  for (let i = 0; i < replacements.length; i++) {
    const node = replacements[i]; await stop(node.child);
    node.child = launch(binary, ["--no-tor", "--bind", new URL(node.origin).host, "--public-url", node.origin,
      "--allow-pubkey", owner, "--data-dir", join(root, `empty-parity-${i}`), "--repair-interval", "0"]);
    await ready(node.child, node.origin);
  }
  const recoveryDeadline = Date.now() + operationTimeout;
  while (true) {
    const report = JSON.parse(readFileSync(join(work, "pool-report.json")));
    if (report.reconstructed && report.protected) break;
    assert.equal(resident.exitCode, null, "Resident repair must stay running");
    if (Date.now() >= recoveryDeadline) throw new Error("Resident owner repair did not repair later loss");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop(resident);
  const expiredArgs = [...repairArgs]; expiredArgs[expiredArgs.indexOf("--expires-at") + 1] = "1";
  const expired = await native([...expiredArgs, "--once"]);
  assert.notEqual(expired.code, 0); assert.equal(expired.stdout, "");
  // All browser/native coded bytes must still agree after both repair generations.
  const recovered = await pageAt(origin, allowed);
  await recovered.page.getByText("Use a saved file event or pool receipt", { exact: true }).click();
  await recovered.page.fill("#saved-event-json", replacementReceiptBytes.toString());
  await recovered.page.click("#verify-saved-event");
  await status(recovered.page, "#retrieve-status", "Pool receipt verified locally");
  await recovered.page.fill("#recovery-key-input", key); await recovered.page.click("#fetch-blossom");
  await status(recovered.page, "#retrieve-status", "reconstructed ciphertext and AES-GCM");
  const nativeDownload = recovered.page.waitForEvent("download");
  await recovered.page.getByRole("link", { name: "Save verified pool-proof.bin" }).click();
  assert.equal(hash(readFileSync(await (await nativeDownload).path())), hash(source));
  await assertNoBrowserPersistence(recovered.page, recovered.context, "native repaired recovery");
  if (process.argv.includes("--tor")) {
    const { acceptPoolTor } = await import("./pool-tor-acceptance.mjs");
    const selected = [
      ...replacementManifest.parts.slice(0, 2).map((part) => nodes.find((node) => `${node.origin}/` === part.targets[1].origin)),
      ...replacements,
    ];
    await acceptPoolTor({ root, binary, manifest: replacementManifest, selected, owner, secret, signerPath,
      port, launch, stop, ready, native, children, hash });
  }
  assert.deepEqual(errors, []);
  process.stdout.write(`Browser ${browserName}; source ${source.length} bytes; native owner repair, exact signer refusal, restart, exclusive lock, repeated unattended loss/repair and expiry passed.\n`);
  process.stdout.write("Pool acceptance passed: six real local nodes plus two replacements, 2-of-4 erasure layout, external signatures, private receipt, no whole ciphertext on an initial node, fresh-browser parity-only recovery, wrong-key rejection, client repair to spares, signed replacement destinations and recovery after every original node stops, two-copy replicated UI mode, native receipt import, no relay/swarm/persistence, accessibility. The browser journey uses local processes; optional real-Tor owner-process results are reported separately. This does not establish independent physical custody.\n");
  }
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
  await Promise.all(children.map(stop));
  rmSync(root, { recursive: true, force: true });
}
