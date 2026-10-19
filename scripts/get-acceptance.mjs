import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { assertNoBrowserPersistence, installBrowserPersistenceAudit } from "./browser-persistence.mjs";
import { closeControlledServer } from "./controlled-server.mjs";

// Recipient page acceptance (design spec 12, checks 2 to 13): the production
// build in real Chromium, a real Rust live-pairing service behind a CORS proxy,
// a synthetic storage server, and an inviter driven from Node with the same
// published kit. Nothing here contacts a real service.
//
//   FOREGATHER_SERVER_BIN   path to a foregather-server executable (required)
//   WILDBLOOM_BROWSER_EXECUTABLE   Chromium or Chrome (macOS default is Chrome)
//   GET_SCREENS_DIR         when set, state screenshots are written there

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverBinary = process.env.FOREGATHER_SERVER_BIN;
if (!serverBinary) throw new Error("Set FOREGATHER_SERVER_BIN to a foregather-server executable.");
accessSync(serverBinary, constants.X_OK);

const kitDirectory = join(repository, "node_modules/@forgesworn/foregather-kit/dist");
const kit = await import(join(kitDirectory, "index.mjs"));
await kit.init({ module_or_path: readFileSync(join(kitDirectory, "foregather_wasm_bg.wasm")) });

const NAMESPACE = "wildbloom.drop";
const PURPOSE = "share";
const now = () => Math.floor(Date.now() / 1000);
const screensDirectory = process.env.GET_SCREENS_DIR ? resolve(process.env.GET_SCREENS_DIR) : undefined;
if (screensDirectory) mkdirSync(screensDirectory, { recursive: true });

// A frozen FSWNENC2 known-answer envelope is the shared file, so the recipient
// is proven against canonical bytes and no encryptor is re-implemented here.
const vector = JSON.parse(readFileSync(join(repository, "test-vectors/fswnenc2-per-file.json"), "utf8"));
const blobBytes = Buffer.from(vector.envelopeBase64, "base64");
const sourceBytes = Buffer.from(vector.source.utf8, "utf8");
const shareKey = `wbk1_${Buffer.from(vector.testOnlyInputKeyHex, "hex").toString("base64url")}`;
assert.equal(blobBytes.length, vector.envelopeBytes);

const temporary = mkdtempSync(join(tmpdir(), "wildbloom-get-"));
const children = new Set();
const servers = new Set();
const contexts = new Set();
const checks = [];
const violations = [];
let browser;

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
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Fixture not ready: ${url}`);
}

async function step(name, work) {
  const started = Date.now();
  await work();
  checks.push({ name, ms: Date.now() - started });
  process.stdout.write(`ok  ${name}\n`);
}

// ------------------------------------------------------------------ fixtures

const operatorToken = randomBytes(32).toString("base64url");
const relayLog = [];
let blossomMode = "ok";
const blossomLog = [];

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

/** The deployed service sits behind a proxy that adds CORS; this stands in for it. */
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

function blossomResponse(request, response) {
  const hash = request.url.slice(1);
  const common = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": request.headers["access-control-request-headers"] ?? "*" };
  if (request.method === "OPTIONS") { response.writeHead(204, common).end(); return; }
  blossomLog.push(`${request.method} ${request.url} ${blossomMode}`);
  if (hash !== vector.envelopeSha256) { response.writeHead(404, common).end(); return; }
  if (blossomMode === "404") { response.writeHead(404, common).end(); return; }
  if (blossomMode === "503") { response.writeHead(503, common).end(); return; }
  if (blossomMode === "drop") { request.socket.destroy(); return; }
  const body = Buffer.from(blobBytes);
  if (blossomMode === "flip") body[Math.floor(body.length / 2)] ^= 0x01;
  response.writeHead(200, { ...common, "Content-Type": "application/octet-stream", "Content-Length": String(body.length) });
  if (blossomMode !== "slow") { response.end(body); return; }
  const slice = Math.ceil(body.length / 6);
  let offset = 0;
  const timer = setInterval(() => {
    response.write(body.subarray(offset, offset + slice));
    offset += slice;
    if (offset >= body.length) { clearInterval(timer); response.end(); }
  }, 150);
  response.on("close", () => clearInterval(timer));
}

async function startBlossom() {
  const server = createServer(blossomResponse);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
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

// ----------------------------------------------------------------- scenarios

async function newShare({ lifetime = 600, descriptor = true } = {}) {
  const offer = kit.createLiveOffer({ namespace: NAMESPACE, purpose: PURPOSE, lifetime, wordCount: 4, now: now() });
  const grant = await fixtures.grants.issue({ operatorToken, resource: "live", expires: now() + 300, maxUses: 1, maxInvitationLifetime: 600 });
  const room = { session: offer.session, secret_format: "words" };
  const allocation = await fixtures.upstream.allocate({ room, createToken: grant.token });
  const link = kit.createPairingLink({ baseUrl: `${fixtures.appOrigin}/get/`, room, namespace: NAMESPACE, purpose: PURPOSE, now: now(), allowLoopbackHttp: true });
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
  const payload = Buffer.from(JSON.stringify({
    v: "wildbloom-share/1",
    url: `${fixtures.blossomOrigin}/${vector.envelopeSha256}`,
    sha256: vector.envelopeSha256,
    size: blobBytes.length,
    key: shareKey,
    name: vector.source.name,
    bytes: vector.source.bytes,
    expires: now() + 86_400,
  }));
  return { offer, link, inviter, outcome, words: offer.secretWords, payload: descriptor ? payload : undefined, grant };
}

async function openRecipient(link, { colorScheme = "light", viewport = { width: 390, height: 844 }, mobile = true } = {}) {
  const context = await browser.newContext({
    acceptDownloads: true,
    colorScheme,
    viewport,
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
  });
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
  const allowed = new Set([fixtures.appOrigin, fixtures.relayOrigin, fixtures.blossomOrigin]);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "data:" || url.protocol === "blob:" || allowed.has(url.origin)) { await route.continue(); return; }
    violations.push(route.request().url());
    await route.abort();
  });
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  const consoleProblems = [];
  const pageErrors = [];
  // The shared Permissions-Policy header lists features this Chrome does not know; that is not this page.
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type()) || message.text().includes("Permissions-Policy header")) return;
    // Polling for the sender's next message answers 404 until it exists; Chrome logs each one.
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
async function typeWords(page, text) {
  await page.locator("#words").fill(text);
}
async function submitWords(page, words) {
  await typeWords(page, words);
  await page.getByRole("button", { name: "Continue" }).click();
}

const DOWNLOADED_REPLY = '{"v":1,"event":"downloaded"}';
const within = (promise, ms) => Promise.race([promise, new Promise((done) => setTimeout(() => done(undefined), ms))]);

/** The sender's side of the one reply: resolves with the bytes, or with undefined if none arrives in time. */
async function expectReply(share) {
  assert.ok(share.reply, "The share must be set up with keepOpen to listen for a reply.");
  const outcome = await within(share.reply, 10_000);
  assert.ok(outcome, "The sender should hear back once the file is saved.");
  assert.ok(outcome.ok, `The reply should reach the sender: ${outcome.error}`);
  assert.equal(Buffer.from(outcome.bytes).toString("utf8"), DOWNLOADED_REPLY, "The reply is exactly the downloaded message.");
  assert.equal(outcome.bytes.length, 28);
}

async function expectNoReply(share, reason) {
  assert.ok(share.reply, "The share must be set up with keepOpen to listen for a reply.");
  assert.equal(await within(share.reply, 1_500), undefined, reason);
}

/**
 * Words entered, three words shown, Yes pressed, details sent. Leaves the page at "Your file is ready".
 * With keepOpen the sender holds the channel and listens for the recipient's one reply in share.reply.
 */
async function toReady(share, recipient, { send = true, keepOpen = false } = {}) {
  const { page } = recipient;
  await submitWords(page, share.words);
  await expectTitle(page, "Check these words with the sender");
  const outcome = await share.outcome;
  assert.ok(outcome.ok, "The inviter should pair with the correct words.");
  const shown = await page.locator(".words-list li").allInnerTexts();
  assert.equal(shown.join(" "), outcome.words, "Both sides must show the same check words.");
  await shot(page, "r12-check-words");
  share.inviter.verify({ matches: true });
  await page.getByRole("button", { name: "Yes, they match" }).click();
  await expectTitle(page, "Waiting for the sender");
  if (send) {
    const receipt = await share.inviter.send({ payload: share.payload, keepOpen });
    assert.equal(receipt.decrypted, true, "The receipt proves the recipient decrypted the details.");
    if (keepOpen) share.reply = share.inviter.awaitReply().then((bytes) => ({ ok: true, bytes }), (error) => ({ ok: false, error }));
    await expectTitle(page, "Your file is ready");
  }
}

async function downloadAndRead(page) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^(Download|Try again)$/u }).click()]);
  return readFileSync(await download.path());
}

// --------------------------------------------------------------------- run

const fixtures = {};
try {
  const service = await startPairingService();
  const blossom = await startBlossom();
  fixtures.blossomOrigin = blossom.origin;
  // The app origin must be known before the CORS proxy, and the proxy before the build.
  const appPort = await freePort();
  fixtures.appOrigin = `http://127.0.0.1:${appPort}`;
  const proxy = await startRelayProxy(service.origin, fixtures.appOrigin);
  fixtures.relayOrigin = proxy.origin;
  await buildApp(proxy.origin);
  const app = launch(process.execPath, [join(repository, "scripts/serve-production.mjs"), "--port", String(appPort)], { cwd: join(temporary, "app") });
  await waitReady(`${fixtures.appOrigin}/healthz`, app);
  fixtures.grants = kit.createCreationGrantClient({ apiUrl: `${service.origin}/v1/`, allowLoopbackHttp: true });
  fixtures.upstream = kit.createLiveRelayClient({ apiUrl: `${service.origin}/v1/`, allowLoopbackHttp: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.WILDBLOOM_BROWSER_EXECUTABLE
      ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"),
  });

  await step("headers: /get has the wasm policy, / does not, /get/ redirects", async () => {
    const get = await fetch(`${fixtures.appOrigin}/get`);
    const index = await fetch(`${fixtures.appOrigin}/`);
    assert.match(get.headers.get("content-security-policy"), /script-src 'self' 'wasm-unsafe-eval'/u);
    assert.doesNotMatch(index.headers.get("content-security-policy"), /wasm-unsafe-eval/u);
    assert.equal(get.headers.get("cache-control"), "no-store");
    const slash = await fetch(`${fixtures.appOrigin}/get/`, { redirect: "manual" });
    assert.equal(slash.status, 301);
    assert.equal(slash.headers.get("location"), "/get");
    const html = await get.text();
    assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/u, "The recipient page has no inline script.");
  });

  await step("R3: no fragment shows the incomplete-link screen with no external or relay request", async () => {
    const { page, requests, consoleProblems } = await openRecipient(`${fixtures.appOrigin}/get`);
    await expectTitle(page, "This link isn't complete");
    assert.ok(requests.every((url) => url.startsWith(fixtures.appOrigin)), `Unexpected requests: ${requests.join(", ")}`);
    assert.equal(relayLog.length, 0);
    assert.deepEqual(consoleProblems, []);
    await shot(page, "r3-incomplete");
  });

  await step("R4: an expired link shows the expired screen with no network", async () => {
    const stale = kit.createLiveOffer({ namespace: NAMESPACE, purpose: PURPOSE, lifetime: 600, now: now() - 700 });
    const link = kit.createPairingLink({
      baseUrl: `${fixtures.appOrigin}/get/`,
      room: { session: stale.session, secret_format: "words" },
      namespace: NAMESPACE,
      purpose: PURPOSE,
      now: now() - 700,
      allowLoopbackHttp: true,
    });
    const { page, requests } = await openRecipient(link);
    await expectTitle(page, "This link has expired");
    assert.ok(requests.every((url) => url.startsWith(fixtures.appOrigin)));
    assert.equal(relayLog.length, 0);
    await shot(page, "r4-expired");
  });

  await step("R5 and local checks: load is silent, trailing slash redirects, typos and counts never reach the relay", async () => {
    const share = await newShare();
    const { page, context, requests, consoleProblems } = await openRecipient(share.link);
    await expectTitle(page, "Get your file");
    assert.ok(requests.every((url) => url.startsWith(fixtures.appOrigin)), "Loading the page makes only same-origin requests.");
    assert.equal(page.url().startsWith(`${fixtures.appOrigin}/get#`), true, "/get/ redirected to /get with the fragment kept.");
    const before = relayLog.length;
    await shot(page, "r5-enter-words");
    await typeWords(page, "orbit lemon frots stone");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#words-error").innerText(), "“frots” isn't one of the words. Check the spelling.");
    assert.equal(await page.locator("#words").getAttribute("aria-invalid"), "true");
    await shot(page, "r5-unknown-word");
    await page.getByRole("button", { name: "Use “frost”" }).click();
    assert.equal(await page.locator("#words").inputValue(), "orbit lemon frost stone");
    await typeWords(page, "orbit lemon");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#words-error").innerText(), "That's 2 words. You need 4.");
    await typeWords(page, "orbit");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#words-error").innerText(), "That's 1 word. You need 4.");
    await typeWords(page, "");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#words-error").innerText(), "Type the 4 words first.");
    await typeWords(page, "Orbit, Lemon. candle-frost");
    assert.equal(await page.locator("#words-hint").innerText(), "4 of 4 words");
    assert.equal(relayLog.length, before, "Local word checks make no relay request.");
    await assertNoBrowserPersistence(page, context, "recipient page at the words screen");
    assert.deepEqual(consoleProblems, []);
    await share.inviter.cancel();
  });

  await step("journey: correct words, matching check words, download, saved bytes equal the source, the sender hears once", async () => {
    blossomMode = "slow";
    const share = await newShare();
    const recipient = await openRecipient(share.link);
    await toReady(share, recipient, { keepOpen: true });
    const { page, context, consoleProblems } = recipient;
    assert.equal(await page.locator(".file-name").innerText(), vector.source.name);
    assert.match(await page.locator(".file-size").innerText(), /^43 B$/u);
    await shot(page, "r15-ready");
    const relayBefore = relayLog.length;
    const bytes = await downloadAndRead(page);
    assert.deepEqual(bytes, sourceBytes, "The saved file is byte for byte the source.");
    await expectTitle(page, "Downloaded");
    await expectReply(share);
    const sent = relayLog.slice(relayBefore);
    assert.equal(sent.length, 1, `Saving the file sends one message to the sender and nothing else: ${JSON.stringify(sent)}`);
    assert.match(await page.locator("#view").innerText(), /Keep this page open until the file has finished saving\./u);
    // Save again works from the copy in memory: no new fetch, and the sender is not told a second time.
    const settled = { relay: relayLog.length, blossom: blossomLog.length };
    const [again] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save again" }).click()]);
    assert.deepEqual(readFileSync(await again.path()), sourceBytes, "Save again gives the same file.");
    await new Promise((done) => setTimeout(done, 500));
    assert.deepEqual({ relay: relayLog.length, blossom: blossomLog.length }, settled, "Save again uses the copy in memory and sends nothing.");
    const titles = await page.evaluate(() => window.__titles);
    for (const expected of ["Downloading", "Checking the file", "Downloaded"]) assert.ok(titles.includes(expected), `Saw ${expected} in ${JSON.stringify(titles)}`);
    assert.ok(titles.indexOf("Downloading") < titles.indexOf("Downloaded"));
    await shot(page, "r18-downloaded");
    await assertNoBrowserPersistence(page, context, "recipient page after a download");
    assert.deepEqual(consoleProblems, []);
    blossomMode = "ok";
  });

  await step("R16: progress is shown while the file arrives", async () => {
    blossomMode = "slow";
    const share = await newShare();
    const recipient = await openRecipient(share.link);
    await toReady(share, recipient);
    const { page } = recipient;
    await page.getByRole("button", { name: "Download" }).click();
    await expectTitle(page, "Downloading");
    await page.locator("progress").waitFor();
    assert.match(await page.locator("progress + p").innerText(), /^\d+(\.\d)? B of 65\.6 kB$|^65\.6 kB of 65\.6 kB$|^\d+(\.\d)? kB of 65\.6 kB$/u);
    await shot(page, "r16-downloading");
    await expectTitle(page, "Downloaded");
    blossomMode = "ok";
  });

  await step("R8: valid but wrong words end the link; the sender side fails too", async () => {
    const share = await newShare();
    const { page, requests } = await openRecipient(share.link);
    const wrong = share.words.split(" ").map((word, index) => (index === 0 ? (word === "zoo" ? "yes" : "zoo") : word)).join(" ");
    await submitWords(page, wrong);
    await expectTitle(page, "Those words didn't work");
    const outcome = await share.outcome;
    assert.equal(outcome.ok, false, "The sender cannot pair when the words are wrong.");
    assert.equal(share.inviter.state, "failed");
    assert.ok(requests.every((url) => url.startsWith(fixtures.appOrigin) || url.startsWith(fixtures.relayOrigin)));
    await shot(page, "r8-wrong-words");
  });

  await step("R9: a second browser opening a claimed link is refused", async () => {
    const share = await newShare();
    const first = await openRecipient(share.link);
    await submitWords(first.page, share.words);
    await expectTitle(first.page, "Check these words with the sender");
    const second = await openRecipient(share.link);
    await submitWords(second.page, share.words);
    await expectTitle(second.page, "This link has already been used");
    await shot(second.page, "r9-already-used");
    first.page.on("dialog", (dialog) => void dialog.dismiss());
    share.inviter.cancel();
  });

  await step("R13: pressing No sends nothing", async () => {
    const share = await newShare();
    const { page } = await openRecipient(share.link);
    await submitWords(page, share.words);
    await expectTitle(page, "Check these words with the sender");
    await page.getByRole("button", { name: "No, they don't" }).click();
    await expectTitle(page, "Nothing was sent");
    await shot(page, "r13-nothing-sent");
    share.inviter.cancel();
  });

  await step("R20: a 404 at Download shows the no-longer-shared screen and the sender hears nothing", async () => {
    const share = await newShare();
    const recipient = await openRecipient(share.link);
    await toReady(share, recipient, { keepOpen: true });
    blossomMode = "404";
    await recipient.page.getByRole("button", { name: "Download" }).click();
    await expectTitle(recipient.page, "This file is no longer shared");
    await shot(recipient.page, "r20-no-longer-shared");
    await expectNoReply(share, "A file that was never saved is never reported as saved.");
    share.inviter.dispose();
    blossomMode = "ok";
  });

  await step("R21: a one-byte change of the same size is rejected, nothing is saved and the sender is not told", async () => {
    const share = await newShare();
    const recipient = await openRecipient(share.link);
    await toReady(share, recipient, { keepOpen: true });
    let downloads = 0;
    recipient.page.on("download", () => { downloads += 1; });
    blossomMode = "flip";
    await recipient.page.getByRole("button", { name: "Download" }).click();
    await expectTitle(recipient.page, "This file didn't pass its check");
    await shot(recipient.page, "r21-failed-check");
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(downloads, 0, "A tampered blob never triggers a download.");
    await expectNoReply(share, "A file that fails its check is never reported as saved.");
    blossomMode = "ok";
    const relayBefore = relayLog.length;
    const bytes = await downloadAndRead(recipient.page);
    assert.deepEqual(bytes, sourceBytes, "Try again after a damaged copy saves the right file.");
    await expectReply(share);
    assert.equal(relayLog.length - relayBefore, 1, "Retrying needs no new pairing; the only request is the reply.");
  });

  await step("R21: a file whose size differs from the share details is rejected, nothing is saved and the sender is not told", async () => {
    const share = await newShare();
    share.payload = Buffer.from(JSON.stringify({ ...JSON.parse(share.payload), bytes: vector.source.bytes + 1 }));
    const recipient = await openRecipient(share.link);
    await toReady(share, recipient, { keepOpen: true });
    let downloads = 0;
    recipient.page.on("download", () => { downloads += 1; });
    await recipient.page.getByRole("button", { name: "Download" }).click();
    await expectTitle(recipient.page, "This file didn't pass its check");
    await expectNoReply(share, "A file of the wrong size is never reported as saved.");
    assert.equal(downloads, 0, "A file of the wrong size is never handed to the browser.");
    share.inviter.dispose();
  });

  await step("R19: an unreachable node shows the unavailable screen; Try again works once it returns, with no re-pairing", async () => {
    const share = await newShare();
    const recipient = await openRecipient(share.link);
    await toReady(share, recipient, { keepOpen: true });
    blossomMode = "drop";
    await recipient.page.getByRole("button", { name: "Download" }).click();
    await expectTitle(recipient.page, "The file isn't available right now");
    await shot(recipient.page, "r19-unavailable");
    blossomMode = "503";
    await recipient.page.getByRole("button", { name: "Try again" }).click();
    await expectTitle(recipient.page, "The file isn't available right now");
    await expectNoReply(share, "A file that could not be fetched is never reported as saved.");
    blossomMode = "ok";
    const relayBefore = relayLog.length;
    const bytes = await downloadAndRead(recipient.page);
    assert.deepEqual(bytes, sourceBytes);
    await expectReply(share);
    assert.equal(relayLog.length - relayBefore, 1, "Try again does not pair again; the only request is the reply.");
  });

  await step("R23: a save the browser refuses sends no reply until Save again works, then exactly one", async () => {
    const share = await newShare();
    const recipient = await openRecipient(share.link);
    await toReady(share, recipient, { keepOpen: true });
    const { page } = recipient;
    await page.evaluate(() => {
      const original = URL.createObjectURL.bind(URL);
      let calls = 0;
      URL.createObjectURL = (blob) => {
        calls += 1;
        if (calls === 1) throw new Error("save refused");
        return original(blob);
      };
    });
    await page.getByRole("button", { name: "Download" }).click();
    await expectTitle(page, "Your browser didn't save the file");
    await shot(page, "r23-save-failed");
    await expectNoReply(share, "A save the browser refused is never reported as saved.");
    const relayBefore = relayLog.length;
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save again" }).click()]);
    assert.deepEqual(readFileSync(await download.path()), sourceBytes, "Save again saves the file from memory.");
    await expectTitle(page, "Downloaded");
    await expectReply(share);
    assert.equal(relayLog.length - relayBefore, 1, "Save again fetches nothing; the only request is the reply.");
  });

  await step("compat: a sender that does not hold the channel open still gets a normal download and the page stays quiet", async () => {
    const share = await newShare();
    const recipient = await openRecipient(share.link);
    await toReady(share, recipient);
    const bytes = await downloadAndRead(recipient.page);
    assert.deepEqual(bytes, sourceBytes);
    await expectTitle(recipient.page, "Downloaded");
    await new Promise((done) => setTimeout(done, 1_000));
    assert.equal(await title(recipient.page), "Downloaded", "The late or refused reply never changes the screen.");
    assert.deepEqual(recipient.pageErrors, [], "The best-effort reply raises no unhandled error.");
  });

  await step("offline: the banner shows, the words are kept and nothing is sent", async () => {
    const share = await newShare();
    const { page, context } = await openRecipient(share.link, { colorScheme: "dark" });
    await expectTitle(page, "Get your file");
    await typeWords(page, share.words);
    const before = relayLog.length;
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForFunction(() => document.getElementById("offline")?.textContent === "You're offline. Connect to the internet to continue.");
    assert.equal(await page.locator("#words").inputValue(), share.words);
    assert.equal(await title(page), "Get your file");
    assert.equal(relayLog.length, before, "Nothing reaches the relay while offline.");
    await shot(page, "r5-offline-dark");
    await context.setOffline(false);
    await page.waitForFunction(() => document.getElementById("offline")?.textContent === "");
    share.inviter.cancel();
  });

  await step("expiry: a link that runs out while open moves to the expired screen", async () => {
    const share = await newShare({ lifetime: 4 });
    const { page } = await openRecipient(share.link);
    await expectTitle(page, "Get your file");
    await expectTitle(page, "This link has expired", 12_000);
    share.inviter.cancel();
  });

  await step("R22: a descriptor over the browser limit is refused", async () => {
    const share = await newShare();
    share.payload = Buffer.from(JSON.stringify({ ...JSON.parse(share.payload), size: 300 * 1024 * 1024, bytes: 299 * 1024 * 1024 }));
    const recipient = await openRecipient(share.link);
    await toReady(share, recipient, { send: false });
    await share.inviter.send({ payload: share.payload });
    await expectTitle(recipient.page, "This file is too big for a browser");
  });

  assert.deepEqual(violations, [], "No request left the three fixture origins.");
  assert.equal(relayLog.some((entry) => entry.includes("shelter.forgesworn.dev")), false);
  process.stdout.write(`${JSON.stringify({ passed: true, checks: checks.length })}\n`);
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  for (const server of servers) await closeControlledServer(server).catch(() => undefined);
  for (const child of children) await stopChild(child).catch(() => undefined);
  rmSync(temporary, { recursive: true, force: true });
}
