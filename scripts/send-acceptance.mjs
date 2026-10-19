import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { chromium, devices } from "playwright-core";
import { assertNoBrowserPersistence, installBrowserPersistenceAudit } from "./browser-persistence.mjs";
import { closeControlledServer } from "./controlled-server.mjs";

// Sender page acceptance (design "Request a file", stage 2): the production
// build of /send in real Chromium emulating Android Chrome, a real Rust live
// pairing service behind a CORS proxy, a real local wildbloomd running with
// --device-grants --request-grants, and Drop's side played from Node with the
// same published kit and the protocol's own calls:
//
//   1. an owner-signed kind 27540 event grants a device key;
//   2. the device asks for a request grant over NIP-98, after the check words;
//   3. the invitation (wildbloom-request/1) goes out as the transfer-v1 bytes;
//   4. the harness lists the upload under the request key, downloads it and
//      opens it with its own independent AES-GCM implementation.
//
// A small proxy sits in front of the node so a body can be cut off mid-upload.
// Nothing here contacts a real service.
//
//   FOREGATHER_SERVER_BIN   path to a foregather-server executable (required)
//   WILDBLOOM_NODE_BIN      path to a wildbloomd built from the request-grants branch (required)
//   WILDBLOOM_BROWSER_EXECUTABLE   Chromium or Chrome (macOS default is Chrome)
//   SEND_SCREENS_DIR        when set, state screenshots are written there
//   SEND_ACCEPTANCE_ONLY    when set, run only the steps whose name contains this text

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverBinary = process.env.FOREGATHER_SERVER_BIN;
if (!serverBinary) throw new Error("Set FOREGATHER_SERVER_BIN to a foregather-server executable.");
accessSync(serverBinary, constants.X_OK);
const nodeBinary = process.env.WILDBLOOM_NODE_BIN;
if (!nodeBinary) throw new Error("Set WILDBLOOM_NODE_BIN to a wildbloomd executable built from the request-grants branch.");
accessSync(nodeBinary, constants.X_OK);

const kitDirectory = join(repository, "node_modules/@forgesworn/foregather-kit/dist");
const kit = await import(join(kitDirectory, "index.mjs"));
await kit.init({ module_or_path: readFileSync(join(kitDirectory, "foregather_wasm_bg.wasm")) });

const NAMESPACE = "wildbloom.drop";
const PURPOSE = "request";
const SERVER_NAME = "127.0.0.1";
const now = () => Math.floor(Date.now() / 1000);
const screensDirectory = process.env.SEND_SCREENS_DIR ? resolve(process.env.SEND_SCREENS_DIR) : undefined;
if (screensDirectory) mkdirSync(screensDirectory, { recursive: true });

const temporary = mkdtempSync(join(tmpdir(), "wildbloom-send-"));
const children = new Set();
const servers = new Set();
const contexts = new Set();
const checks = [];
const notes = [];
const violations = [];
let browser;

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const secretOf = () => new Uint8Array(randomBytes(32));
const within = (promise, ms) => Promise.race([promise, new Promise((done) => setTimeout(() => done(undefined), ms))]);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const value = probe.address().port;
  await closeControlledServer(probe);
  return value;
}

function launch(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], ...options });
  children.add(child);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function waitReady(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, "A fixture server exited before it was ready.");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch { /* still starting */ }
    await pause(100);
  }
  throw new Error(`Fixture not ready: ${url}`);
}

// SEND_ACCEPTANCE_ONLY=<text> runs only the steps whose name contains it, for working on one case.
const only = process.env.SEND_ACCEPTANCE_ONLY;

async function step(name, work) {
  if (only && !name.includes(only)) return;
  const started = Date.now();
  await work();
  checks.push({ name, ms: Date.now() - started });
  process.stdout.write(`ok  ${name}\n`);
}

// ------------------------------------------------------------------ fixtures

const operatorToken = randomBytes(32).toString("base64url");
const relayLog = [];
const fixtures = {};

async function startPairingService() {
  const child = launch(serverBinary, [], {
    env: {
      ...process.env,
      FOREGATHER_DB: join(temporary, "pairing-db"),
      FOREGATHER_CREATE_TOKEN: operatorToken,
      FOREGATHER_BIND: "127.0.0.1:0",
      FOREGATHER_ENABLE_LIVE: "1",
    },
  });
  const origin = await new Promise((done, fail) => {
    let text = "";
    const timer = setTimeout(() => fail(new Error("Pairing service start-up timed out.")), 10_000);
    child.stderr.on("data", (chunk) => {
      text += chunk;
      const match = /listening on (127\.0\.0\.1:\d+)/u.exec(text);
      if (match) { clearTimeout(timer); done(`http://${match[1]}`); }
    });
    child.once("exit", () => { clearTimeout(timer); fail(new Error("Pairing service exited.")); });
  });
  return { child, origin };
}

/** The deployed pairing service sits behind a proxy that adds CORS; this stands in for it. */
async function startRelayProxy(upstream, appOrigin) {
  const server = createServer(async (request, response) => {
    const headers = {
      "Access-Control-Allow-Origin": appOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": request.headers["access-control-request-headers"] ?? "authorization, content-type, accept",
      Vary: "Origin",
    };
    const url = new URL(request.url, "http://proxy.invalid");
    relayLog.push(`${request.method} ${url.pathname}`);
    if (request.method === "OPTIONS") { response.writeHead(204, headers).end(); return; }
    if (!url.pathname.startsWith("/pair/v1/")) { response.writeHead(404, headers).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const forwarded = {};
      for (const name of ["authorization", "content-type", "accept"]) if (request.headers[name]) forwarded[name] = request.headers[name];
      const upstreamResponse = await fetch(`${upstream}/v1/${url.pathname.slice("/pair/v1/".length)}`, {
        method: request.method,
        headers: forwarded,
        body: ["POST", "PUT"].includes(request.method) ? Buffer.concat(chunks) : undefined,
        redirect: "error",
      });
      response.writeHead(upstreamResponse.status, { ...headers, "Content-Type": upstreamResponse.headers.get("content-type") ?? "application/json" });
      response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
    } catch {
      response.writeHead(502, headers).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * The real node's public face. It forwards everything to wildbloomd and can
 * cut the next upload off part-way, which a network does and a node does not.
 * `corsOnRefusals` stands in for a node that answers its own refusals with
 * CORS headers: see the note near the end of the run.
 */
async function startNodeProxy(publicPort, upstreamPort) {
  const control = { log: [], cutNext: undefined, corsOnRefusals: false };
  const server = createServer((incoming, outgoing) => {
    const entry = { method: incoming.method, path: incoming.url.split("?")[0], status: undefined, bytes: 0, cut: false, authorization: incoming.headers.authorization };
    control.log.push(entry);
    const cutAfter = incoming.method === "PUT" && entry.path === "/upload" && control.cutNext ? control.cutNext.after : undefined;
    if (cutAfter !== undefined) control.cutNext = undefined;
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: upstreamPort,
      method: incoming.method,
      path: incoming.url,
      headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}` },
    }, (answer) => {
      entry.status = answer.statusCode;
      // Every request gets a fresh connection: Chrome quietly repeats a PUT that fails on a reused one,
      // which would hide the cut-off from the page.
      const headers = { ...answer.headers, connection: "close" };
      if (control.corsOnRefusals && !headers["access-control-allow-origin"]) {
        headers["access-control-allow-origin"] = "*";
        headers["access-control-expose-headers"] = "X-Reason, Content-Type";
      }
      outgoing.writeHead(answer.statusCode, headers);
      answer.pipe(outgoing);
    });
    upstream.on("error", () => outgoing.destroy());
    incoming.on("data", (chunk) => {
      if (entry.cut) return;
      entry.bytes += chunk.length;
      if (cutAfter !== undefined && entry.bytes >= cutAfter) {
        entry.cut = true;
        upstream.destroy();
        incoming.socket.destroy();
        return;
      }
      upstream.write(chunk);
    });
    incoming.on("end", () => { if (!entry.cut) upstream.end(); });
    incoming.on("error", () => upstream.destroy());
  });
  server.listen(publicPort, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  return { server, control, origin: `http://127.0.0.1:${publicPort}` };
}

async function startNode(publicOrigin, port, ownerPubkey) {
  const child = launch(nodeBinary, [
    "--no-tor",
    "--bind", `127.0.0.1:${port}`,
    "--public-url", publicOrigin,
    "--server-name", SERVER_NAME,
    "--allow-pubkey", ownerPubkey,
    "--device-grants",
    "--request-grants",
    "--data-dir", join(temporary, "node-data"),
    "--repair-interval", "0",
    "--quota-bytes", String(64 * 1024 * 1024),
    "--max-blob-bytes", String(8 * 1024 * 1024),
  ]);
  await waitReady(`http://127.0.0.1:${port}/`, child);
  return child;
}

async function buildApp(relayOrigin) {
  const dist = join(temporary, "app", "dist");
  const build = launch("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], {
    cwd: repository,
    env: { ...process.env, VITE_WILDBLOOM_PAIR_RELAY: `${relayOrigin}/pair/v1/` },
  });
  let diagnostics = "";
  build.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const [code] = await once(build, "exit");
  assert.equal(code, 0, `Production build failed: ${diagnostics}`);
}

// --------------------------------------------------- Drop's side, from the protocol

const owner = secretOf();
const ownerPubkey = getPublicKey(owner);

const base64 = (value) => Buffer.from(value).toString("base64");

/** A node-bound NIP-98 header, as the pairing issuer and the request routes expect. */
function nip98(secret, url, method, body) {
  const tags = [["u", url], ["method", method]];
  if (method === "POST") tags.push(["payload", sha256(body)]);
  const event = finalizeEvent({ kind: 27235, created_at: now(), tags, content: "" }, secret);
  return `Nostr ${base64(JSON.stringify(event))}`;
}

/** A BUD-11 header signed with a request key, for listing and deleting its own claims. */
function bud11(secret, verb, hash) {
  const created = now();
  const tags = [["t", verb], ["server", SERVER_NAME], ["expiration", String(created + 60)]];
  if (hash) tags.push(["x", hash]);
  const event = finalizeEvent({ kind: 24242, created_at: created, tags, content: "Authorise blob request" }, secret);
  return `Nostr ${base64(JSON.stringify(event))}`;
}

/** Owner-signed kind 27540: this device may ask for request grants. A fresh pair of keys per call keeps the node's limits out of the way. */
async function grantDevice() {
  const device = secretOf();
  const recovery = secretOf();
  const created = now();
  const event = finalizeEvent({
    kind: 27540,
    created_at: created,
    tags: [
      ["t", "grant"],
      ["device", getPublicKey(device)],
      ["recovery", getPublicKey(recovery)],
      ["bytes", String(8 * 1024 * 1024)],
      ["until", String(created + 3 * 3600)],
      ["server", SERVER_NAME],
      ["expiration", String(created + 300)],
    ],
    content: "Acceptance device",
  }, owner);
  const response = await fetch(`${fixtures.nodeOrigin}/grants/v1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
  assert.ok(response.ok, `The owner-signed device grant was refused: ${response.status} ${await response.text()}`);
  return device;
}

async function issueRequestGrant(device, { pubkey, bytes, until }) {
  const body = JSON.stringify({ pubkey, bytes, until });
  const response = await fetch(`${fixtures.nodeOrigin}/request/v1/upload-grants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: nip98(device, `${fixtures.nodeOrigin}/request/v1/upload-grants`, "POST", body) },
    body,
  });
  const text = await response.text();
  assert.equal(response.status, 201, `The request grant was refused: ${response.status} ${text}`);
  assert.deepEqual(JSON.parse(text), { pubkey, bytes, until });
}

async function endRequestGrant(device, pubkey) {
  const url = `${fixtures.nodeOrigin}/request/v1/upload-grants/${pubkey}`;
  const response = await fetch(url, { method: "DELETE", headers: { Authorization: nip98(device, url, "DELETE", "") } });
  assert.equal(response.status, 200, `Ending the request grant failed: ${response.status}`);
  assert.deepEqual(await response.json(), { pubkey, state: "ended" });
}

/** What the request key's own claims are, as Drop lists them. */
async function listClaims(secret) {
  const pubkey = getPublicKey(secret);
  const response = await fetch(`${fixtures.nodeOrigin}/list/${pubkey}`, { headers: { Authorization: bud11(secret, "list") } });
  assert.equal(response.status, 200, `Listing the request key's claims failed: ${response.status}`);
  return response.json();
}

async function waitForClaims(secret, count, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let claims = [];
  while (Date.now() < deadline) {
    claims = await listClaims(secret);
    if (claims.length >= count) return claims;
    await pause(200);
  }
  throw new Error(`Expected ${count} claim(s) under the request key, found ${claims.length}.`);
}

async function fetchBlob(hash) {
  const response = await fetch(`${fixtures.nodeOrigin}/${hash}`);
  assert.equal(response.status, 200, `Downloading ${hash} failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(bytes), hash, "The downloaded bytes match the claim's hash.");
  return bytes;
}

// An independent FSWNENC2 reader on Node's own crypto, as in tests/fswnenc2.test.ts:
// the page's encryptor is checked against a second implementation, not itself.
function openEnvelope(envelope, fileKey) {
  const inputKey = Buffer.from(fileKey.slice("wbk1_".length), "base64url");
  assert.equal(inputKey.length, 32);
  assert.equal(envelope.subarray(0, 8).toString("latin1"), "FSWNENC2");
  const salt = envelope.subarray(24, 56);
  const key = Buffer.from(hkdfSync("sha256", inputKey, salt, Buffer.from("forgesworn-aes-256-gcm-chunked/v2", "utf8"), 32));
  const chunk = envelope.readUInt32BE(8);
  const records = envelope.readUInt32BE(12);
  const noncePrefix = envelope.subarray(16, 24);
  const header = envelope.subarray(0, 56);
  const parts = [];
  let offset = 56;
  for (let counter = 0; counter < records; counter += 1) {
    const bodyLength = counter === records - 1 ? envelope.length - offset - 16 : chunk;
    const ciphertext = envelope.subarray(offset, offset + bodyLength);
    const tag = envelope.subarray(offset + bodyLength, offset + bodyLength + 16);
    offset += bodyLength + 16;
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce);
    nonce.writeUInt32BE(counter, 8);
    const aad = Buffer.alloc(60);
    header.copy(aad, 0);
    aad.writeUInt32BE(counter, 56);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    parts.push(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }
  const plaintext = Buffer.concat(parts);
  const metadataLength = plaintext.readUInt32BE(0);
  const metadata = JSON.parse(plaintext.subarray(4, 4 + metadataLength).toString("utf8"));
  assert.deepEqual(Object.keys(metadata), ["name", "size", "type"]);
  return { ...metadata, source: Buffer.from(plaintext.subarray(4 + metadataLength, 4 + metadataLength + metadata.size)) };
}

/** The reply, read as strictly as Drop reads it. */
function readSendingReply(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text);
  assert.deepEqual(Object.keys(value).sort(), ["event", "sha256", "size", "v"]);
  assert.equal(text, JSON.stringify({ v: 1, event: "sending", sha256: value.sha256, size: value.size }), "The reply is the canonical bytes.");
  assert.equal(value.v, 1);
  assert.equal(value.event, "sending");
  assert.match(value.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(Number.isSafeInteger(value.size) && value.size > 0);
  return value;
}

/**
 * One request, from Drop's side. `confirm` does what Drop does after the check
 * words: ask the node for the request grant, then send the invitation and hold
 * the channel for the optional reply.
 */
async function newRequest({
  lifetime = 600,
  bytes = 400_000,
  size = 600_000,
  grantBytes = size,
  untilIn = 3_600,
  invitationUntil,
  linkBase = `${fixtures.appOrigin}/send/`,
} = {}) {
  const offer = kit.createLiveOffer({ namespace: NAMESPACE, purpose: PURPOSE, lifetime, wordCount: 4, now: now() });
  const grant = await fixtures.grants.issue({ operatorToken, resource: "live", expires: now() + 300, maxUses: 1, maxInvitationLifetime: 600 });
  const room = { session: offer.session, secret_format: "words" };
  const allocation = await fixtures.upstream.allocate({ room, createToken: grant.token });
  const link = kit.createPairingLink({ baseUrl: linkBase, room, namespace: NAMESPACE, purpose: PURPOSE, now: now(), allowLoopbackHttp: true });
  const inviter = kit.createPairingFlow({
    session: offer.session,
    secretWords: offer.secretWords,
    role: "inviter",
    namespace: NAMESPACE,
    purpose: PURPOSE,
    now,
    transport: fixtures.upstream.inviter({ allocation }),
  });
  const outcome = inviter.pair().then((words) => ({ ok: true, words }), (error) => ({ ok: false, error }));
  const requestSecret = secretOf();
  const fileKey = `wbk1_${randomBytes(32).toString("base64url")}`;
  const request = {
    offer,
    link,
    inviter,
    outcome,
    words: offer.secretWords,
    requestSecret,
    pubkey: getPublicKey(requestSecret),
    fileKey,
    bytes,
    size,
    grantRequested: false,
    device: undefined,
    until: undefined,
    reply: undefined,
    async confirm({ sendInvitation = true } = {}) {
      request.device = await grantDevice();
      request.until = invitationUntil?.() ?? now() + untilIn;
      request.grantRequested = true;
      await issueRequestGrant(request.device, { pubkey: request.pubkey, bytes: grantBytes, until: request.until });
      if (!sendInvitation) return;
      const payload = Buffer.from(JSON.stringify({
        v: "wildbloom-request/1",
        node: `${fixtures.nodeOrigin}/`,
        signer: hex(requestSecret),
        key: fileKey,
        size,
        bytes,
        files: 1,
        until: request.until,
      }));
      const receipt = await inviter.send({ payload, keepOpen: true });
      assert.equal(receipt.decrypted, true, "The receipt proves the page decrypted the invitation.");
      request.reply = inviter.awaitReply().then((reply) => ({ ok: true, bytes: reply }), (error) => ({ ok: false, error }));
    },
    /** An invitation of the caller's own making, for the cases a real Drop never produces. */
    async sendRaw(payload) {
      const receipt = await inviter.send({ payload: Buffer.from(payload), keepOpen: true });
      assert.equal(receipt.decrypted, true);
    },
  };
  return request;
}

// ------------------------------------------------------------------- browser

async function openSender(link, { colorScheme = "light", device = "Pixel 7" } = {}) {
  const context = await browser.newContext({ ...devices[device], acceptDownloads: false, colorScheme });
  contexts.add(context);
  await context.addInitScript(installBrowserPersistenceAudit);
  await context.addInitScript(() => {
    window.__titles = [];
    const watch = () => {
      const title = document.getElementById("title");
      if (!title) return false;
      new MutationObserver(() => window.__titles.push(title.textContent)).observe(title, { childList: true, characterData: true, subtree: true });
      return true;
    };
    if (!watch()) document.addEventListener("DOMContentLoaded", watch);
  });
  // Count what the page asks of the Screen Wake Lock API (the browser may still refuse it, headless or not).
  await context.addInitScript(() => {
    window.__wakeLock = { requests: 0, granted: 0, releases: 0 };
    const locks = navigator.wakeLock;
    if (!locks) return;
    const original = locks.request.bind(locks);
    locks.request = async (type) => {
      window.__wakeLock.requests += 1;
      const sentinel = await original(type);
      window.__wakeLock.granted += 1;
      const release = sentinel.release.bind(sentinel);
      sentinel.release = async () => { window.__wakeLock.releases += 1; return release(); };
      return sentinel;
    };
  });
  const allowed = new Set([fixtures.appOrigin, fixtures.relayOrigin, fixtures.nodeOrigin]);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "data:" || url.protocol === "blob:" || allowed.has(url.origin)) { await route.continue(); return; }
    violations.push(route.request().url());
    await route.abort();
  });
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
  const consoleProblems = [];
  const pageErrors = [];
  // The shared Permissions-Policy header lists features this Chrome does not know; that is not this page.
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type()) || message.text().includes("Permissions-Policy header")) return;
    // Polling for the other side's next message answers 404 until it exists; Chrome logs each one.
    if (message.text().includes("status of 404") && message.location().url.startsWith(fixtures.relayOrigin)) return;
    consoleProblems.push(message.text());
  });
  page.on("pageerror", (error) => { pageErrors.push(String(error)); consoleProblems.push(String(error)); });
  await page.goto(link);
  return { context, page, requests, consoleProblems, pageErrors };
}

const title = (page) => page.locator("#title").textContent();
async function expectTitle(page, expected, timeout = 20_000) {
  await page.waitForFunction((text) => document.getElementById("title")?.textContent === text, expected, { timeout }).catch(async () => {
    throw new Error(`Expected "${expected}" but the page shows "${await title(page)}" (${await page.locator("#view").innerText().catch(() => "")}).`);
  });
}
async function shot(page, name) {
  if (screensDirectory) await page.screenshot({ path: join(screensDirectory, `${name}.png`) });
}
async function submitWords(page, words) {
  await page.locator("#words").fill(words);
  await page.getByRole("button", { name: "Continue" }).click();
}
async function expectNoOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label} scrolls sideways by ${overflow}px.`);
}

/** Words entered, check words compared, Yes pressed, grant and invitation sent. Leaves the page at "Choose a file". */
async function toChoose(request, sender, options) {
  const { page } = sender;
  await submitWords(page, request.words);
  await expectTitle(page, "Check these words with them");
  const outcome = await request.outcome;
  assert.ok(outcome.ok, "The inviter pairs with the correct words.");
  const shown = await page.locator(".words-list li").allInnerTexts();
  assert.equal(shown.join(" "), outcome.words, "Both sides show the same check words.");
  await shot(page, "check-words");
  request.inviter.verify({ matches: true });
  await page.getByRole("button", { name: "Yes, they match" }).click();
  await expectTitle(page, "Waiting for them");
  await request.confirm(options);
  if (options?.sendInvitation !== false) await expectTitle(page, "Choose a file");
}

const proxy = () => fixtures.nodeProxy.control;
const uploadCalls = (since) => proxy().log.slice(since).filter((entry) => entry.path === "/upload");

const sample = (length, seed = 1) => Buffer.from(Uint8Array.from({ length }, (_, index) => (index * 31 + seed * 17 + (index >> 8)) & 0xff));

async function chooseFile(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /^Choose (a|another) file$/u }).click()]);
  await chooser.setFiles(file);
}

/** The claim the node holds under the request key, opened with the file key. */
async function expectUploaded(request, { name, type, source }) {
  const claims = await waitForClaims(request.requestSecret, 1);
  assert.equal(claims.length, 1, "Exactly one claim sits under the request key.");
  const claim = claims[0];
  const envelope = await fetchBlob(claim.sha256);
  assert.equal(claim.size, envelope.length);
  const opened = openEnvelope(envelope, request.fileKey);
  assert.equal(opened.name, name);
  assert.equal(opened.type, type);
  assert.equal(opened.size, source.length);
  assert.ok(opened.source.equals(source), "The file decrypts, with the key Drop chose, to the exact bytes the phone held.");
  assert.ok(claim.size <= request.size, "The envelope fits the invitation's limit.");
  return claim;
}

// --------------------------------------------------------------------- run

try {
  const service = await startPairingService();
  const appPort = await freePort();
  const nodePort = await freePort();
  const publicNodePort = await freePort();
  fixtures.appOrigin = `http://127.0.0.1:${appPort}`;
  fixtures.nodeOrigin = `http://127.0.0.1:${publicNodePort}`;
  const relayProxy = await startRelayProxy(service.origin, fixtures.appOrigin);
  fixtures.relayOrigin = relayProxy.origin;
  fixtures.nodeProxy = await startNodeProxy(publicNodePort, nodePort);
  await startNode(fixtures.nodeOrigin, nodePort, ownerPubkey);
  await buildApp(relayProxy.origin);
  const app = launch(process.execPath, [join(repository, "scripts/serve-production.mjs"), "--port", String(appPort)], { cwd: join(temporary, "app") });
  await waitReady(`${fixtures.appOrigin}/healthz`, app);
  fixtures.grants = kit.createCreationGrantClient({ apiUrl: `${service.origin}/v1/`, allowLoopbackHttp: true });
  fixtures.upstream = kit.createLiveRelayClient({ apiUrl: `${service.origin}/v1/`, allowLoopbackHttp: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.WILDBLOOM_BROWSER_EXECUTABLE
      ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"),
  });

  await step("headers: /send has the wasm policy and may keep the screen on; / and /get may not; /send/ redirects", async () => {
    const send = await fetch(`${fixtures.appOrigin}/send`);
    const get = await fetch(`${fixtures.appOrigin}/get`);
    const index = await fetch(`${fixtures.appOrigin}/`);
    assert.match(send.headers.get("content-security-policy"), /script-src 'self' 'wasm-unsafe-eval'/u);
    assert.doesNotMatch(index.headers.get("content-security-policy"), /wasm-unsafe-eval/u);
    assert.match(send.headers.get("permissions-policy"), /screen-wake-lock=\(self\)/u);
    assert.match(get.headers.get("permissions-policy"), /screen-wake-lock=\(\)/u);
    assert.match(index.headers.get("permissions-policy"), /screen-wake-lock=\(\)/u);
    assert.equal(send.headers.get("cache-control"), "no-store");
    const slash = await fetch(`${fixtures.appOrigin}/send/`, { redirect: "manual" });
    assert.equal(slash.status, 301);
    assert.equal(slash.headers.get("location"), "/send");
    assert.equal((await fetch(`${fixtures.appOrigin}/send.html`)).status, 404);
    assert.doesNotMatch(await send.text(), /<script[^>]*>[^<]+<\/script>/u, "The sender page has no inline script.");
  });

  await step("setup: the node accepts an owner-signed device grant and a request grant over NIP-98, and refuses a key it has seen", async () => {
    const device = await grantDevice();
    const secret = secretOf();
    const until = now() + 600;
    await issueRequestGrant(device, { pubkey: getPublicKey(secret), bytes: 100_000, until });
    // The same key again is refused: a request key is never granted twice.
    const body = JSON.stringify({ pubkey: getPublicKey(secret), bytes: 100_000, until });
    const again = await fetch(`${fixtures.nodeOrigin}/request/v1/upload-grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: nip98(device, `${fixtures.nodeOrigin}/request/v1/upload-grants`, "POST", body) },
      body,
    });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, "key_in_use");
    await endRequestGrant(device, getPublicKey(secret));
  });

  await step("incomplete link: no fragment shows the incomplete-link screen with no external or node request", async () => {
    const proxyBefore = proxy().log.length;
    const relayBefore = relayLog.length;
    const { page, requests, consoleProblems } = await openSender(`${fixtures.appOrigin}/send`);
    await expectTitle(page, "This link isn't complete");
    assert.ok(requests.every((entry) => entry.includes(fixtures.appOrigin)), `Unexpected requests: ${requests.join(", ")}`);
    assert.equal(relayLog.length, relayBefore);
    assert.equal(proxy().log.length, proxyBefore);
    assert.deepEqual(consoleProblems, []);
    await shot(page, "incomplete");
  });

  await step("words: loading is silent, typos and counts never reach the relay, /send/ keeps the fragment", async () => {
    const request = await newRequest();
    const { page, context, requests, consoleProblems } = await openSender(request.link);
    await expectTitle(page, "Send a file");
    assert.equal(await page.locator("#view p").first().innerText(), "Type the 4 words they told you.");
    assert.ok(requests.every((entry) => entry.includes(fixtures.appOrigin)), "Loading the page makes only same-origin requests.");
    assert.equal(page.url().startsWith(`${fixtures.appOrigin}/send#`), true, "/send/ redirected to /send with the fragment kept.");
    const relayBefore = relayLog.length;
    const proxyBefore = proxy().log.length;
    await shot(page, "words");
    await page.locator("#words").fill("orbit lemon frots stone");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#words-error").innerText(), "“frots” isn't one of the words. Check the spelling.");
    await page.getByRole("button", { name: "Use “frost”" }).click();
    assert.equal(await page.locator("#words").inputValue(), "orbit lemon frost stone");
    await page.locator("#words").fill("orbit lemon");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#words-error").innerText(), "That's 2 words. You need 4.");
    await page.locator("#words").fill("");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#words-error").innerText(), "Type the 4 words first.");
    assert.equal(relayLog.length, relayBefore, "Local word checks make no relay request.");
    assert.equal(proxy().log.length, proxyBefore, "Nothing reaches the node before a request exists.");
    await expectNoOverflow(page, "the words screen");
    await assertNoBrowserPersistence(page, context, "sender page at the words screen");
    assert.deepEqual(consoleProblems, []);
    await request.inviter.cancel();
  });

  await step("journey (Android Chrome): words, check words, invitation, a chosen file is locked, sent, listed under the request key and opens with Drop's key", async () => {
    const request = await newRequest();
    const sender = await openSender(request.link);
    const { page, context, consoleProblems } = sender;
    assert.match(await page.evaluate(() => navigator.userAgent), /Android .*Chrome\/.* Mobile/u, "The page runs as Android Chrome.");
    assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true);
    assert.equal(await page.evaluate(() => (document.permissionsPolicy ?? document.featurePolicy)?.allowsFeature("screen-wake-lock")), true, "The page may ask to keep the screen on.");
    await toChoose(request, sender);
    assert.equal(await page.locator("#view p").first().innerText(), "It's locked on this phone before it's sent, so only they can open it. Up to 400 kB.");
    await shot(page, "choose");
    await expectNoOverflow(page, "the choose screen");

    const source = sample(250_000, 3);
    const proxyBefore = proxy().log.length;
    await chooseFile(page, { name: "holiday.mp4", mimeType: "video/mp4", buffer: source });
    await expectTitle(page, "Sent");
    assert.equal(await page.locator("#view p").first().innerText(), "holiday.mp4 has reached their storage. You can close this page.");
    await shot(page, "sent");
    await expectNoOverflow(page, "the sent screen");

    const titles = await page.evaluate(() => window.__titles);
    for (const expected of ["Getting it ready", "Sending holiday.mp4", "Sent"]) assert.ok(titles.includes(expected), `Saw ${expected} in ${JSON.stringify(titles)}`);
    assert.ok(titles.indexOf("Getting it ready") < titles.indexOf("Sending holiday.mp4") && titles.indexOf("Sending holiday.mp4") < titles.indexOf("Sent"));

    // The node saw a preflight, then the upload, both signed by the request key for its host.
    const calls = uploadCalls(proxyBefore).filter((entry) => entry.method !== "OPTIONS");
    assert.deepEqual(calls.map((entry) => `${entry.method} ${entry.status}`), ["HEAD 200", "PUT 201"]);
    for (const entry of calls) {
      const event = JSON.parse(Buffer.from(entry.authorization.slice("Nostr ".length), "base64").toString("utf8"));
      assert.equal(event.pubkey, request.pubkey);
      assert.deepEqual(event.tags.find((tag) => tag[0] === "server"), ["server", SERVER_NAME]);
    }

    const claim = await expectUploaded(request, { name: "holiday.mp4", type: "video/mp4", source });
    const reply = await within(request.reply, 10_000);
    assert.ok(reply?.ok, `Drop hears the early reply: ${reply?.error}`);
    assert.deepEqual(readSendingReply(reply.bytes), { v: 1, event: "sending", sha256: claim.sha256, size: claim.size }, "The early reply carries the envelope's hash and size and nothing else.");
    const wake = await page.evaluate(() => window.__wakeLock);
    assert.ok(wake.requests >= 1, "The page asked to keep the screen on while it locked and sent the file.");
    assert.equal(wake.releases, wake.granted, "The page let the screen sleep again once the file was sent.");
    await assertNoBrowserPersistence(page, context, "sender page after an upload");
    assert.deepEqual(consoleProblems, []);
  });

  await step("a file picked in landscape on a phone: the choose screen fits and the upload still works", async () => {
    const request = await newRequest();
    const sender = await openSender(request.link, { device: "Pixel 7 landscape" });
    await toChoose(request, sender);
    await expectNoOverflow(sender.page, "the choose screen in landscape");
    await shot(sender.page, "choose-landscape");
    await chooseFile(sender.page, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("a short note\n") });
    await expectTitle(sender.page, "Sent");
    await expectUploaded(request, { name: "notes.txt", type: "text/plain", source: Buffer.from("a short note\n") });
  });

  await step("wrong words: valid but wrong words end the link, the other side fails too and no grant is ever asked for", async () => {
    const request = await newRequest();
    const proxyBefore = proxy().log.length;
    const { page } = await openSender(request.link);
    const wrong = request.words.split(" ").map((word, index) => (index === 0 ? (word === "zoo" ? "yes" : "zoo") : word)).join(" ");
    await submitWords(page, wrong);
    await expectTitle(page, "Those words didn't work");
    const outcome = await request.outcome;
    assert.equal(outcome.ok, false, "Drop cannot pair when the words are wrong.");
    assert.equal(request.inviter.state, "failed");
    assert.equal(request.grantRequested, false);
    assert.equal(proxy().log.length, proxyBefore, "The node is never contacted, so no write authority exists.");
    await shot(page, "wrong-words");
  });

  await step("a second browser opening a claimed link is told it has been used", async () => {
    const request = await newRequest();
    const first = await openSender(request.link);
    await submitWords(first.page, request.words);
    await expectTitle(first.page, "Check these words with them");
    const second = await openSender(request.link);
    await submitWords(second.page, request.words);
    await expectTitle(second.page, "This link has already been used");
    await shot(second.page, "used");
    first.page.on("dialog", (dialog) => void dialog.dismiss());
    request.inviter.cancel();
  });

  await step("mismatch: pressing No sends nothing and no grant is asked for", async () => {
    const request = await newRequest();
    const proxyBefore = proxy().log.length;
    const { page } = await openSender(request.link);
    await submitWords(page, request.words);
    await expectTitle(page, "Check these words with them");
    await page.getByRole("button", { name: "No, they don't" }).click();
    await expectTitle(page, "Nothing was sent");
    assert.equal(request.grantRequested, false);
    assert.equal(proxy().log.length, proxyBefore);
    await shot(page, "mismatch");
    request.inviter.cancel();
  });

  await step("expired: a link that runs out while open moves to the expired screen", async () => {
    const request = await newRequest({ lifetime: 4 });
    const { page } = await openSender(request.link);
    await expectTitle(page, "Send a file");
    await expectTitle(page, "This link has expired", 12_000);
    await shot(page, "expired-link");
    request.inviter.cancel();
  });

  await step("expired invitation: a request whose grant has already ended is an ended request, with no node contact", async () => {
    const request = await newRequest();
    const sender = await openSender(request.link);
    const proxyBefore = proxy().log.length;
    await submitWords(sender.page, request.words);
    await expectTitle(sender.page, "Check these words with them");
    await request.outcome;
    request.inviter.verify({ matches: true });
    await sender.page.getByRole("button", { name: "Yes, they match" }).click();
    await expectTitle(sender.page, "Waiting for them");
    const requestSecret = secretOf();
    await request.sendRaw(JSON.stringify({
      v: "wildbloom-request/1",
      node: `${fixtures.nodeOrigin}/`,
      signer: hex(requestSecret),
      key: request.fileKey,
      size: 600_000,
      bytes: 400_000,
      files: 1,
      until: now() - 5,
    }));
    await expectTitle(sender.page, "This request has ended");
    assert.equal(await sender.page.locator("#view p").first().innerText(), "Ask them to send you a new request.");
    assert.equal(proxy().log.length, proxyBefore, "An ended request never touches the node.");
    await shot(sender.page, "ended-at-once");
  });

  await step("expired invitation: a grant that runs out while the person is choosing ends the request by itself", async () => {
    const request = await newRequest({ invitationUntil: () => now() + 7 });
    const sender = await openSender(request.link);
    await toChoose(request, sender);
    const proxyBefore = proxy().log.length;
    await expectTitle(sender.page, "This request has ended", 15_000);
    await shot(sender.page, "ended-while-choosing");
    assert.equal(await sender.page.getByRole("button", { name: "Choose a file" }).count(), 0, "There is no way to pick a file for a request that has ended.");
    assert.equal(proxy().log.length, proxyBefore);
  });

  await step("an invitation the page cannot use is not a request: it stops on its own screen and nothing is signed", async () => {
    const request = await newRequest();
    const sender = await openSender(request.link);
    const proxyBefore = proxy().log.length;
    await submitWords(sender.page, request.words);
    await expectTitle(sender.page, "Check these words with them");
    await request.outcome;
    request.inviter.verify({ matches: true });
    await sender.page.getByRole("button", { name: "Yes, they match" }).click();
    await expectTitle(sender.page, "Waiting for them");
    await request.sendRaw(JSON.stringify({ v: "wildbloom-request/2", node: `${fixtures.nodeOrigin}/` }));
    await expectTitle(sender.page, "This request can't be used");
    assert.equal(proxy().log.length, proxyBefore);
    await shot(sender.page, "invalid");
  });

  await step("over-limit: a file over the limit, an empty file and one whose envelope would not fit are refused before any upload, then a good file goes", async () => {
    const request = await newRequest({ bytes: 1_000_000, size: 1_048_576 });
    const sender = await openSender(request.link);
    const { page } = sender;
    await toChoose(request, sender);
    assert.match(await page.locator("#view p").first().innerText(), /Up to 1\.0 MB\.$/u);
    const proxyBefore = proxy().log.length;

    await chooseFile(page, { name: "too-big.bin", mimeType: "application/octet-stream", buffer: sample(1_000_001) });
    await expectTitle(page, "This file is too big");
    assert.equal(await page.locator("#view p").first().innerText(), "You can send up to 1.0 MB.");
    await shot(page, "too-big");
    await expectNoOverflow(page, "the too-big screen");

    await chooseFile(page, { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) });
    await expectTitle(page, "That file is empty");
    await shot(page, "empty");

    // Exactly at the plaintext limit, but a 1,000,000-byte file locks to 1,048,648 bytes, over the 1,048,576 the request allows.
    await chooseFile(page, { name: "edge.bin", mimeType: "application/octet-stream", buffer: sample(1_000_000) });
    await expectTitle(page, "This file is too big");

    assert.equal(proxy().log.slice(proxyBefore).filter((entry) => entry.path === "/upload").length, 0, "Nothing was sent to the node's upload route.");
    assert.equal((await listClaims(request.requestSecret)).length, 0);

    const source = sample(200_000, 9);
    await chooseFile(page, { name: "small.bin", mimeType: "application/octet-stream", buffer: source });
    await expectTitle(page, "Sent");
    await expectUploaded(request, { name: "small.bin", type: "application/octet-stream", source });
  });

  await step("cut-off upload: the connection breaks mid-body, the node keeps nothing, the page says so, retries with a fresh event and then succeeds", async () => {
    const request = await newRequest();
    const sender = await openSender(request.link);
    const { page } = sender;
    await toChoose(request, sender);
    const source = sample(300_000, 5);
    proxy().cutNext = { after: 100_000 };
    const proxyBefore = proxy().log.length;
    await chooseFile(page, { name: "photo.jpg", mimeType: "image/jpeg", buffer: source });
    await page.getByText("The connection dropped. Trying again…").waitFor({ timeout: 15_000 }).catch(async (error) => {
      throw new Error(`${error.message} Page: ${await title(page)} / ${await page.locator("#view").innerText()}; node saw ${JSON.stringify(proxy().log.slice(proxyBefore).map(({ authorization, ...rest }) => rest))}`);
    });
    await shot(page, "retrying");
    assert.equal(await title(page), "Sending photo.jpg");
    const afterCut = proxy().log.slice(proxyBefore).filter((entry) => entry.method === "PUT" && entry.path === "/upload");
    assert.equal(afterCut.length, 1);
    assert.equal(afterCut[0].cut, true, "The first upload was cut off part-way.");
    assert.deepEqual(await listClaims(request.requestSecret), [], "The node kept nothing from the cut-off body.");
    await expectTitle(page, "Sent", 30_000);
    const puts = proxy().log.slice(proxyBefore).filter((entry) => entry.method === "PUT" && entry.path === "/upload");
    assert.deepEqual(puts.map((entry) => [entry.cut, entry.status]), [[true, undefined], [false, 201]], "One cut-off attempt, one that completed.");
    const events = puts.map((entry) => JSON.parse(Buffer.from(entry.authorization.slice("Nostr ".length), "base64").toString("utf8")));
    assert.notEqual(events[0].id, events[1].id, "The retry signs a fresh event.");
    assert.ok(events[1].created_at - events[0].created_at >= 4, "The retry waited for its slot.");
    await expectUploaded(request, { name: "photo.jpg", type: "image/jpeg", source });
    const reply = await within(request.reply, 5_000);
    assert.ok(reply?.ok, "Drop heard the early reply before the first attempt.");
  });

  await step("node refusal, a real 507: a file the grant cannot hold stops on the no-room screen and nothing is kept", async () => {
    // The grant allows 70,000 bytes but the invitation promises 600,000, as a Drop with a stale limit would.
    const request = await newRequest({ grantBytes: 70_000 });
    const sender = await openSender(request.link);
    await toChoose(request, sender);
    const proxyBefore = proxy().log.length;
    await chooseFile(sender.page, { name: "big.bin", mimeType: "application/octet-stream", buffer: sample(200_000) });
    await expectTitle(sender.page, "Their storage can't take this file");
    const answers = proxy().log.slice(proxyBefore).filter((entry) => entry.path === "/upload" && entry.method !== "OPTIONS").map((entry) => `${entry.method} ${entry.status}`);
    assert.ok(answers.includes("HEAD 507") || answers.includes("PUT 507"), `The node refused with 507: ${answers.join(", ")}`);
    assert.equal(proxy().log.slice(proxyBefore).filter((entry) => entry.method === "PUT" && entry.path === "/upload").length <= 1, true, "A refusal is not retried.");
    assert.deepEqual(await listClaims(request.requestSecret), []);
    await shot(sender.page, "no-room");
    // The same page can send something that does fit.
    const small = sample(20_000, 2);
    await chooseFile(sender.page, { name: "fits.bin", mimeType: "application/octet-stream", buffer: small });
    await expectTitle(sender.page, "Sent");
    await expectUploaded(request, { name: "fits.bin", type: "application/octet-stream", source: small });
  });

  await step("node refusal, request_ended: when Drop stops waiting, the node's 403 becomes the ended screen and no bytes are sent", async () => {
    const request = await newRequest();
    const sender = await openSender(request.link);
    await toChoose(request, sender);
    await endRequestGrant(request.device, request.pubkey);
    proxy().corsOnRefusals = true;
    const proxyBefore = proxy().log.length;
    try {
      await chooseFile(sender.page, { name: "late.txt", mimeType: "text/plain", buffer: Buffer.from("too late") });
      await expectTitle(sender.page, "This request has ended");
    } finally {
      proxy().corsOnRefusals = false;
    }
    const answers = proxy().log.slice(proxyBefore).filter((entry) => entry.path === "/upload" && entry.method !== "OPTIONS");
    assert.deepEqual(answers.map((entry) => `${entry.method} ${entry.status}`), ["HEAD 403"], "The preflight was refused and nothing was uploaded.");
    await shot(sender.page, "ended-by-node");
    assert.equal(await sender.page.getByRole("button", { name: /Try again|Choose/u }).count(), 0);
  });

  await step("note: what a browser can see of the node's own refusals", async () => {
    // wildbloomd's grant gate sits outside the core's CORS layer, so its refusals
    // (403 request_ended, 403 upload_only) carry no CORS headers: a browser sees a
    // failed request, not the 403 above. The page then retries, and ends the request
    // itself once the grant's end time has passed. This is recorded, not asserted.
    const request = await newRequest();
    await request.confirm({ sendInvitation: false });
    await endRequestGrant(request.device, request.pubkey);
    const hash = sha256("x");
    const refusal = await fetch(`${fixtures.nodeOrigin}/upload`, {
      method: "HEAD",
      headers: { Origin: fixtures.appOrigin, Authorization: bud11(request.requestSecret, "upload", hash), "X-SHA-256": hash, "X-Content-Length": "1", "X-Content-Type": "application/octet-stream" },
    });
    notes.push({
      refusal: refusal.status,
      reason: refusal.headers.get("x-reason"),
      corsHeadersOnRefusal: refusal.headers.get("access-control-allow-origin") !== null,
    });
    assert.equal(refusal.status, 403);
    assert.equal(refusal.headers.get("x-reason"), "request_ended");
    request.inviter.cancel();
  });

  await step("offline: the banner shows on the words screen, the words are kept and nothing is sent", async () => {
    const request = await newRequest();
    const { page, context } = await openSender(request.link, { colorScheme: "dark" });
    await expectTitle(page, "Send a file");
    await page.locator("#words").fill(request.words);
    const before = relayLog.length;
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForFunction(() => document.getElementById("offline")?.textContent === "You're offline. Connect to the internet to continue.");
    assert.equal(await page.locator("#words").inputValue(), request.words);
    assert.equal(await title(page), "Send a file");
    assert.equal(relayLog.length, before, "Nothing reaches the relay while offline.");
    await shot(page, "offline-dark");
    await context.setOffline(false);
    await page.waitForFunction(() => document.getElementById("offline")?.textContent === "");
    request.inviter.cancel();
  });

  assert.deepEqual(violations, [], "No request left the fixture origins.");
  process.stdout.write(`${JSON.stringify({ passed: true, checks: checks.length, notes })}\n`);
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  for (const server of servers) await closeControlledServer(server).catch(() => undefined);
  for (const child of children) await stopChild(child).catch(() => undefined);
  rmSync(temporary, { recursive: true, force: true });
}
