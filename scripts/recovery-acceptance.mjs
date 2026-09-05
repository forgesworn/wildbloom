import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import { assertNoBrowserPersistence, installBrowserPersistenceAudit } from "./browser-persistence.mjs";
import { closeControlledServer } from "./controlled-server.mjs";
import { privateRecordOutput } from "./private-record.mjs";
import { inspectProductionBuild } from "./production-build.mjs";

// Public synthetic signing fixture. Only this harness signs; the app receives exact
// signed-event JSON through its normal handoff controls, never signing key material.
const fixtureKey = new Uint8Array(32).fill(23);
const pubkey = getPublicKey(fixtureKey);
const sourceBytes = Buffer.alloc(1024 * 1024 + 19, 73);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binary = process.env.WILDBLOOM_NODE_BIN;
if (!binary) throw new Error("Set WILDBLOOM_NODE_BIN to the reviewed wildbloomd executable.");
accessSync(binary, constants.X_OK);
const build = inspectProductionBuild();
const nodeVersion = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
assert.equal(nodeVersion.status, 0, "Node executable must report its version");
const root = mkdtempSync(join(tmpdir(), "wildbloom-recovery-"));
const children = new Set();
const contexts = new Set();
const relayEvents = new Map();
const fixtureErrors = [];
let browser;
let evidence;
const relay = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 128 * 1024 });
relay.on("error", () => fixtureErrors.push("Controlled relay error"));
relay.on("connection", (socket, request) => {
  if (request.url !== "/") fixtureErrors.push("Unexpected tracker/swarm connection");
  socket.on("message", (bytes) => {
    try {
      const message = JSON.parse(bytes.toString());
      if (message[0] === "EVENT") {
        const event = message[1];
        assert.ok(verifyEvent(event) && event.pubkey === pubkey);
        relayEvents.set(event.id, event);
        socket.send(JSON.stringify(["OK", event.id, true, "stored"]));
      } else if (message[0] === "REQ") {
        for (const id of message[2].ids ?? []) {
          if (relayEvents.has(id)) socket.send(JSON.stringify(["EVENT", message[1], relayEvents.get(id)]));
        }
        socket.send(JSON.stringify(["EOSE", message[1]]));
      }
    } catch { fixtureErrors.push("Controlled relay received an invalid event/request"); }
  });
});

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await closeControlledServer(server);
  return value;
}
function launch(command, args) {
  const child = spawn(command, args, { stdio: "ignore" });
  child.on("error", () => fixtureErrors.push("Acceptance child failed to start"));
  children.add(child);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function ready(child, origin, path) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, "Acceptance server exited before readiness");
    try {
      if ((await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch { /* Startup only; no retry of a mutation. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Acceptance server did not become ready");
}
async function startNode(label) {
  const origin = `http://127.0.0.1:${await port()}`;
  const dataDir = join(root, label);
  const args = ["--no-tor", "--bind", new URL(origin).host, "--public-url", origin,
    "--allow-pubkey", pubkey, "--data-dir", dataDir, "--repair-interval", "0"];
  const child = launch(binary, args);
  await ready(child, origin, "/");
  return { origin, dataDir, child, args };
}
async function pageAt(origin, allowed) {
  const context = await browser.newContext({ acceptDownloads: true });
  contexts.add(context);
  await context.addInitScript(installBrowserPersistenceAudit);
  await context.addInitScript(() => {
    window.__wildbloomRecoveryPeerUsed = false;
    Object.defineProperty(window, "RTCPeerConnection", { value: class {
      constructor() {
        window.__wildbloomRecoveryPeerUsed = true;
        throw new Error("Recovery acceptance forbids implicit peer delivery");
      }
    } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const requests = [];
  const sockets = [];
  page.on("pageerror", () => fixtureErrors.push("Browser page error"));
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    if (!allowed.has(url.origin)) {
      fixtureErrors.push("Browser attempted an undeclared origin");
      await route.abort();
    } else await route.continue();
  });
  await page.goto(origin);
  await page.locator("#inspect-file").waitFor();
  assert.ok(requests.every((url) => new URL(url).origin === origin), "No network action on load");
  assert.equal(sockets.length, 0);
  return { context, page, requests, sockets };
}
async function status(page, selector, text) {
  await page.locator(selector).filter({ hasText: text }).waitFor();
}
async function handoff(page, kind) {
  await page.waitForFunction((expected) => {
    try { return JSON.parse(document.querySelector("#external-unsigned-event").value).kind === expected; }
    catch { return false; }
  }, kind);
  const template = JSON.parse(await page.inputValue("#external-unsigned-event"));
  const signed = finalizeEvent(template, fixtureKey);
  await page.fill("#external-signed-event", JSON.stringify(signed));
  await page.click("#accept-external-signature");
  return signed;
}

try {
  if (!relay.address()) await once(relay, "listening");
  const relayUrl = `ws://127.0.0.1:${relay.address().port}/`;
  const primary = await startNode("primary");
  const replica = await startNode("replica");
  const appOrigin = `http://127.0.0.1:${await port()}`;
  const app = launch(process.execPath, ["scripts/serve-production.mjs", "--port", new URL(appOrigin).port]);
  await ready(app, appOrigin, "/healthz");
  browser = await chromium.launch({ headless: true, executablePath: process.env.WILDBLOOM_BROWSER_EXECUTABLE
    ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome") });
  const allowed = new Set([appOrigin, primary.origin, replica.origin]);
  const publisher = await pageAt(appOrigin, allowed);
  const p = publisher.page;
  assert.equal(await p.evaluate(() => typeof window.nostr), "undefined");
  await p.fill("#blossom-server", primary.origin);
  await p.fill("#relay-urls", relayUrl);
  await p.fill("#tracker-urls", `${relayUrl}tracker`);
  await p.check('input[name="signing-method"][value="external"]');
  await p.fill("#external-signer-pubkey", pubkey);
  await p.click("#connect-signer");
  await p.setInputFiles("#publish-file", { name: "recovery-proof.bin", mimeType: "application/octet-stream", buffer: sourceBytes });
  await p.click("#inspect-file");
  await status(p, "#publish-status", "Encrypted transfer payload prepared");
  const recoveryKey = await p.inputValue("#recovery-key-output");
  await p.check("#key-saved-consent");
  await p.check("#upload-consent");
  await p.click("#upload-file");
  await handoff(p, 24242);
  await status(p, "#publish-status", "hybrid metadata is staged");
  await p.click("#sign-events");
  const event = await handoff(p, 1063);
  await handoff(p, 2003);
  await status(p, "#publish-status", "Exact external signatures accepted");
  await p.check("#publish-consent");
  await p.click("#publish-events");
  await status(p, "#publish-status", "2/2 acknowledgements");
  const ciphertextHash = event.tags.find(([name]) => name === "x")[1];
  const signedUrl = event.tags.find(([name]) => name === "url")[1];
  assert.equal(new URL(signedUrl).origin, primary.origin);
  assert.ok(!JSON.stringify([...relayEvents.values()]).includes(recoveryKey));
  assert.ok(!JSON.stringify([...relayEvents.values()]).includes("recovery-proof.bin"));
  const bytesResponse = await fetch(signedUrl, { signal: AbortSignal.timeout(5_000) });
  assert.equal(bytesResponse.status, 200);
  const ciphertext = Buffer.from(await bytesResponse.arrayBuffer());
  assert.equal(hash(ciphertext), ciphertextHash);
  assert.ok(!ciphertext.includes(sourceBytes));
  // This explicit fixture setup creates the existing replica. The product never
  // uploads or mirrors as a side effect of choosing a retrieval endpoint.
  const created = Math.floor(Date.now() / 1000);
  const auth = finalizeEvent({ kind: 24242, created_at: created, content: "Synthetic recovery acceptance upload",
    tags: [["t", "upload"], ["x", ciphertextHash], ["server", new URL(replica.origin).hostname], ["expiration", String(created + 60)]] }, fixtureKey);
  const upload = await fetch(`${replica.origin}/upload`, { method: "PUT", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
      "Content-Type": "application/vnd.forgesworn.encrypted", "X-SHA-256": ciphertextHash }, body: ciphertext });
  assert.ok(upload.ok, "Second real node must accept the authorised ciphertext");
  assert.equal((await upload.json()).sha256, ciphertextHash);
  await assertNoBrowserPersistence(p, publisher.context, "Publisher");
  await publisher.context.close();
  contexts.delete(publisher.context);
  await stop(primary.child);
  await stop(replica.child);
  replica.child = launch(binary, replica.args);
  await ready(replica.child, replica.origin, "/");
  process.stdout.write("Encrypted publication completed through the manual handoff; publisher context discarded, original node stopped, replica restarted.\n");

  const retriever = await pageAt(appOrigin, allowed);
  const r = retriever.page;
  for (const id of ["event-id", "recovery-key-input", "replica-server", "external-signer-pubkey"]) assert.equal(await r.inputValue(`#${id}`), "");
  assert.equal(await r.evaluate(() => typeof window.nostr), "undefined");
  await r.fill("#relay-urls", relayUrl);
  await r.fill("#event-id", event.id);
  await r.click("#resolve-event");
  await status(r, "#retrieve-status", "separately received recovery key");
  await r.fill("#recovery-key-input", recoveryKey);
  await r.click("#fetch-blossom");
  await r.locator("#retrieve-status.error").waitFor();
  assert.equal(await r.locator("#retrieve-links a").count(), 0);

  const beforeSelection = retriever.requests.length;
  await r.check("#download-swarm-consent");
  await r.fill("#replica-server", replica.origin);
  assert.equal(retriever.requests.length, beforeSelection, "Selecting a replica cannot make a network request");
  assert.equal(await r.inputValue("#recovery-key-input"), "");
  assert.equal(await r.isChecked("#download-swarm-consent"), false);
  assert.ok(await r.isDisabled("#fetch-blossom"), "Changed endpoint invalidates earlier download consent");
  await r.click("#resolve-event");
  await status(r, "#retrieve-status", "separately received recovery key");
  await r.fill("#recovery-key-input", `wbk1_${Buffer.alloc(32, 99).toString("base64url")}`);
  await r.click("#fetch-blossom");
  await r.locator("#retrieve-status.error").waitFor();
  assert.equal(await r.locator("#retrieve-links a").count(), 0, "Wrong key cannot produce a save link");
  await r.fill("#recovery-key-input", recoveryKey);
  await r.click("#fetch-blossom");
  await status(r, "#retrieve-status", "locally decrypted bytes");
  const downloaded = r.waitForEvent("download");
  await r.getByRole("link", { name: "Save verified recovery-proof.bin" }).click();
  const file = await downloaded;
  assert.equal(hash(readFileSync(await file.path())), hash(sourceBytes));
  assert.ok(retriever.requests.slice(beforeSelection).filter((url) => new URL(url).origin !== appOrigin)
    .every((url) => url === `${replica.origin}/${ciphertextHash}`), "Only chosen hash-addressed replica may receive retrieval HTTP requests");
  assert.equal(await r.inputValue("#recovery-key-input"), "");
  assert.deepEqual(publisher.sockets, [relayUrl, relayUrl]);
  assert.ok(retriever.sockets.every((url) => url === relayUrl));
  assert.equal(await r.evaluate(() => window.__wildbloomRecoveryPeerUsed), false);

  // Disk corruption must be detected despite a successful HTTP response, and
  // must clear an earlier verified download. A real source-loss error is separate.
  await stop(replica.child);
  const corrupt = Buffer.from(ciphertext);
  corrupt[corrupt.length - 1] ^= 1;
  writeFileSync(join(replica.dataDir, "blobs", ciphertextHash.slice(0, 2), ciphertextHash), corrupt);
  replica.child = launch(binary, replica.args);
  await ready(replica.child, replica.origin, "/");
  await r.fill("#recovery-key-input", recoveryKey);
  await r.click("#fetch-blossom");
  await status(r, "#retrieve-status.error", "SHA-256");
  assert.equal(await r.locator("#retrieve-links a").count(), 0);
  await assertNoBrowserPersistence(r, retriever.context, "Fresh retriever");
  await r.reload();
  assert.equal(await r.inputValue("#replica-server"), "");
  assert.equal(await r.inputValue("#recovery-key-input"), "");
  assert.equal(await r.locator("#retrieve-links a").count(), 0);
  assert.deepEqual(fixtureErrors, []);
  assert.deepEqual(inspectProductionBuild(), build, "Production build changed during acceptance");
  evidence = { format: "wildbloom-application-recovery-v1", verifiedAt: new Date().toISOString(),
    browserSourceCommit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    browserSourceClean: spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim() === "",
    build, nodeVersion: nodeVersion.stdout.trim(), nodeBinarySha256: hash(readFileSync(binary)),
    nodeSourceCommit: process.env.WILDBLOOM_NODE_SOURCE_COMMIT ?? null, browserVersion: browser.version(),
    checks: ["manual-event-handoff", "no-browser-persistence", "fresh-signer-free-retriever", "original-node-stopped",
      "replica-restarted", "explicit-replica-choice", "wrong-key-refused", "exact-file-recovered", "corrupt-copy-refused", "stale-save-cleared"],
    limits: "Two loopback Node processes on one host and a synthetic signer fixture; physical devices, real signer custody and ongoing replica policy remain separate." };
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  await closeControlledServer(relay);
  for (const child of children) await stop(child);
  rmSync(root, { recursive: true, force: true });
}
if (process.env.WILDBLOOM_RECOVERY_EVIDENCE) {
  writeFileSync(privateRecordOutput(process.env.WILDBLOOM_RECOVERY_EVIDENCE, "Recovery evidence"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}
process.stdout.write("Application recovery passed: fresh browser, original Node unavailable, exact replica recovery after restart, wrong-key and corrupt-copy refusal, no retained browser state.\n");
