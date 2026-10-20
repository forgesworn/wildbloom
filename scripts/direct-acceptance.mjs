import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { once } from "node:events";
import { accessSync, closeSync, constants, createReadStream, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright-core";
import { assertNoBrowserPersistence, installBrowserPersistenceAudit } from "./browser-persistence.mjs";
import { closeControlledServer } from "./controlled-server.mjs";

// Direct send acceptance: the phone page /send in Chromium emulating Android
// Chrome, the test receiver (Drop's part) in a second Chromium, a real Rust
// live-pairing service behind a CORS proxy, and, where coturn is installed, a
// real TURN server. Two browsers, two real RTCPeerConnections, one file moving
// between them. Nothing here contacts a real service.
//
//   FOREGATHER_SERVER_BIN          path to a foregather-server executable (required)
//   WILDBLOOM_BROWSER_EXECUTABLE   Chromium or Chrome (macOS default is Chrome)
//   COTURN_BIN                     path to turnserver; otherwise it is looked for on PATH
//   COTURN_DOCKER_IMAGE            a coturn image already on this machine, used when there is no turnserver
//                                  (default coturn/coturn:4.17.2-r0; it is never pulled). DIRECT_NO_DOCKER=1 skips it
//   DIRECT_REQUIRE_TURN=1          fail instead of skipping the relay-only case when coturn is missing
//   DIRECT_ACCEPTANCE_ONLY         run only the journeys whose names contain this text (several, separated by |)
//   DIRECT_SCREENS_DIR             when set, screenshots of the phone are written there
//
// The script never prints an exchange message: they carry the TURN credential
// and the file key.

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverBinary = process.env.FOREGATHER_SERVER_BIN;
if (!serverBinary) throw new Error("Set FOREGATHER_SERVER_BIN to a foregather-server executable.");
accessSync(serverBinary, constants.X_OK);

const kitDirectory = join(repository, "node_modules/@forgesworn/foregather-kit/dist");
const kit = await import(join(kitDirectory, "index.mjs"));
await kit.init({ module_or_path: readFileSync(join(kitDirectory, "foregather_wasm_bg.wasm")) });

const NAMESPACE = "wildbloom.drop";
const PURPOSE = "send";
const MAX = 250_000_000;
const now = () => Math.floor(Date.now() / 1000);
const only = (process.env.DIRECT_ACCEPTANCE_ONLY ?? "").split("|").filter(Boolean);
const screensDirectory = process.env.DIRECT_SCREENS_DIR ? resolve(process.env.DIRECT_SCREENS_DIR) : undefined;
if (screensDirectory) mkdirSync(screensDirectory, { recursive: true });

const temporary = mkdtempSync(join(tmpdir(), "wildbloom-direct-"));
const children = new Set();
const servers = new Set();
const contexts = new Set();
const sockets = new Set();
const checks = [];
const violations = [];
const skipped = [];
let phoneBrowser;
let dropBrowser;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sample = (length, seed = 1) => Buffer.from(Uint8Array.from({ length }, (_, index) => (index * 31 + seed * 17 + (index >> 8)) & 0xff));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function freePort(kind = "tcp") {
  if (kind === "udp") {
    const probe = dgram.createSocket("udp4");
    probe.bind(0, "127.0.0.1");
    await once(probe, "listening");
    const value = probe.address().port;
    probe.close();
    return value;
  }
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
    await sleep(100);
  }
  throw new Error(`Fixture not ready: ${url}`);
}

async function step(name, work) {
  if (only.length > 0 && !only.some((part) => name.includes(part))) return;
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

/** The deployed service sits behind a proxy that adds CORS; this stands in for it, for the two page origins. */
async function startRelayProxy(upstream, allowedOrigins) {
  const server = createServer(async (request, response) => {
    const origin = allowedOrigins.has(request.headers.origin) ? request.headers.origin : [...allowedOrigins][0];
    const headers = {
      "Access-Control-Allow-Origin": origin,
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

const MIME = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".wasm", "application/wasm"]]);

/** A plain static server for the test receiver, which exists only in this script's temporary directory. */
async function startStatic(root) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://static.invalid").pathname;
    const file = join(root, path === "/" ? "index.html" : path);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": MIME.get(extname(file)) ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runVite(args, env, label) {
  const build = launch("npx", ["vite", "build", ...args], { cwd: repository, env: { ...process.env, ...env } });
  let diagnostics = "";
  build.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const [code] = await once(build, "exit");
  assert.equal(code, 0, `${label} build failed: ${diagnostics}`);
}

// ---------------------------------------------------------------------- TURN

const TURN_SECRET = randomBytes(24).toString("base64url");
/** The cap KithMoot's coturn puts on each allocation, in bytes a second. The relayed journey runs through it. */
const TURN_MAX_BPS = 1_000_000;

/** A REST credential in coturn's use-auth-secret form, with a random label as the real mint uses. */
function turnCredential(label) {
  const username = `${now() + 3600}:${label}-${randomBytes(6).toString("hex")}`;
  return { username, credential: createHmac("sha1", TURN_SECRET).update(username).digest("base64") };
}

function findCoturn() {
  const candidates = [process.env.COTURN_BIN, ...(process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, "turnserver"))].filter(Boolean);
  return candidates.find((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
}

/** A STUN binding request, to know a server is answering. */
async function stunAnswers(port) {
  const socket = dgram.createSocket("udp4");
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0);
  request.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(request, 8);
  try {
    const reply = new Promise((done) => socket.once("message", () => done(true)));
    socket.send(request, port, "127.0.0.1");
    return await Promise.race([reply, sleep(500).then(() => false)]);
  } finally {
    socket.close();
  }
}

/** The last lines of a log file, for a failure message: why a server would not start is in its own output. */
function lastLines(path, count = 40) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/u).filter((line) => line.length > 0).slice(-count).join("\n");
  } catch {
    return "(no log was written)";
  }
}

async function startTurn(binary, port) {
  const configuration = join(temporary, "turnserver.conf");
  const log = join(temporary, "turnserver.log");
  writeFileSync(configuration, [
    `listening-port=${port}`,
    "listening-ip=127.0.0.1",
    "relay-ip=127.0.0.1",
    "min-port=49200",
    "max-port=49500",
    "fingerprint",
    "use-auth-secret",
    `static-auth-secret=${TURN_SECRET}`,
    "realm=wildbloom.test",
    "no-tls",
    // Older coturn starts DTLS listeners, and wants a certificate for them, unless told not to; newer coturn calls this redundant and carries on.
    "no-dtls",
    // Without this, older coturn binds a telnet console as well, and exits if another coturn on the machine holds its port.
    "no-cli",
    "no-tcp-relay",
    // coturn refuses peers on 127.0.0.0/8 unless told otherwise; both browsers here are on loopback.
    "allow-loopback-peers",
    "no-multicast-peers",
    `max-bps=${TURN_MAX_BPS}`,
    // Every file it writes goes under the temporary directory, so it runs as an ordinary user: its pid file, and its user
    // database, which older coturn opens at /var/lib/turn even when credentials come from the shared secret.
    `pidfile=${join(temporary, "turn.pid")}`,
    `userdb=${join(temporary, "turndb")}`,
    "verbose",
    "log-file=stdout",
    "simple-log",
  ].join("\n"));
  // Its output goes to a file, so that when it will not start the reason is not lost.
  const descriptor = openSync(log, "w");
  const child = launch(binary, ["-c", configuration], { stdio: ["ignore", descriptor, descriptor] });
  closeSync(descriptor);
  const refuse = (message) => new Error(`${message}\nThe last lines coturn wrote:\n${lastLines(log)}`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw refuse(`coturn exited before it was ready (${child.exitCode ?? child.signalCode}).`);
    if (await stunAnswers(port)) return child;
    await sleep(200);
  }
  throw refuse("coturn did not answer a STUN request.");
}

const dockerContainers = new Set();
const DOCKER_IMAGE = process.env.COTURN_DOCKER_IMAGE ?? "coturn/coturn:4.17.2-r0";

/** A coturn image that is already here, and Docker to run it. Nothing is pulled or installed. */
function dockerCoturnAvailable() {
  if (process.env.DIRECT_NO_DOCKER === "1") return false;
  try {
    execFileSync("docker", ["image", "inspect", DOCKER_IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The same server in a throwaway container: its relay addresses are published on this machine's loopback. */
async function startTurnDocker(port) {
  const name = `wildbloom-direct-turn-${randomBytes(3).toString("hex")}`;
  const low = 50_000 + Math.floor(Math.random() * 8_000);
  const high = low + 39;
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", name,
    "-p", `${port}:${port}/udp`, "-p", `${low}-${high}:${low}-${high}/udp`,
    DOCKER_IMAGE,
    "-n", "--use-auth-secret", `--static-auth-secret=${TURN_SECRET}`, "--realm=wildbloom.test",
    `--listening-port=${port}`, `--min-port=${low}`, `--max-port=${high}`,
    "--external-ip=127.0.0.1", "--allow-loopback-peers", "--no-multicast-peers", "--fingerprint",
    "--no-tls", "--no-dtls", "--no-tcp-relay", `--max-bps=${TURN_MAX_BPS}`,
    "--log-file=stdout", "--simple-log",
  ], { stdio: "ignore" });
  dockerContainers.add(name);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await stunAnswers(port)) return name;
    await sleep(250);
  }
  let output = "";
  try {
    output = execFileSync("docker", ["logs", "--tail", "40", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    output = "(no log could be read)";
  }
  throw new Error(`The coturn container did not answer a STUN request.\nThe last lines it wrote:\n${output}`);
}

// -------------------------------------------------------------------- UDP shim

/**
 * Lets the script slow or cut the path between the two browsers without root:
 * the test receiver sends each host candidate through here, so every packet
 * passes through two UDP sockets. A front socket stands for each real address;
 * a packet sent to a front is forwarded to the real address it stands for, from
 * the front of the sender, so both ends see exactly the addresses they were told.
 */
class PathShim {
  fronts = new Map();
  cut = false;
  bytesPerSecond = Number.POSITIVE_INFINITY;
  forwarded = 0;
  dropped = 0;
  #nextFree = 0;

  async proxyFor(role, ip, port) {
    const key = `${ip}:${port}`;
    const known = this.fronts.get(key);
    if (known) return known.front.address().port;
    const front = dgram.createSocket("udp4");
    sockets.add(front);
    front.bind(0, "127.0.0.1");
    await once(front, "listening");
    const entry = { role, ip, port, front };
    this.fronts.set(key, entry);
    front.on("message", (message, from) => this.#forward(entry, message, from));
    return front.address().port;
  }

  #forward(target, message, from) {
    if (this.cut) { this.dropped += 1; return; }
    // The sender is the real socket this packet came from; its front is the address the target was told about.
    // Both browsers are on this machine, so a port names a socket, whichever local address the packet carries.
    const source = [...this.fronts.values()].find((entry) => entry.port === from.port);
    if (!source) { this.dropped += 1; return; }
    const send = () => {
      if (this.cut) { this.dropped += 1; return; }
      source.front.send(message, target.port, target.ip);
      this.forwarded += 1;
    };
    if (!Number.isFinite(this.bytesPerSecond)) { send(); return; }
    const at = Math.max(Date.now(), this.#nextFree);
    // A queue deeper than a fifth of a second drops the packet, as a real bottleneck does.
    if (at - Date.now() > 200) { this.dropped += 1; return; }
    this.#nextFree = at + (message.length / this.bytesPerSecond) * 1000;
    setTimeout(send, Math.max(0, at - Date.now()));
  }

  close() {
    for (const { front } of this.fronts.values()) front.close();
    this.fronts.clear();
  }
}

// ------------------------------------------------------------------- scenarios

let turn; // { port, urls, host }

/** A new session: the words, the link and the test receiver's configuration. */
async function newSession({ hide = false, max = MAX, lifetime = 600, shim, gatherMs, restartAfterMs, giveUpMs } = {}) {
  const offer = kit.createLiveOffer({ namespace: NAMESPACE, purpose: PURPOSE, lifetime, wordCount: 4, now: now() });
  const grant = await fixtures.grants.issue({ operatorToken, resource: "live", expires: now() + 300, maxUses: 1, maxInvitationLifetime: 600 });
  const room = { session: offer.session, secret_format: "words" };
  const allocation = await fixtures.upstream.allocate({ room, createToken: grant.token });
  const link = kit.createPairingLink({ baseUrl: `${fixtures.appOrigin}/send/`, room, namespace: NAMESPACE, purpose: PURPOSE, now: now(), allowLoopbackHttp: true });
  const page = turnCredential("page");
  const drop = turnCredential("drop");
  const server = (credential) => ({ urls: turn.urls, username: credential.username, credential: credential.credential });
  return {
    words: offer.secretWords,
    link,
    config: {
      relayApi: `${fixtures.relayOrigin}/pair/v1/`,
      session: offer.session,
      secretWords: offer.secretWords,
      allocation,
      namespace: NAMESPACE,
      purpose: PURPOSE,
      inviteIce: [server(page)],
      dropIce: [server(drop)],
      hide,
      max,
      id: randomBytes(16).toString("base64url"),
      shim: shim !== undefined,
      ...(gatherMs === undefined ? {} : { gatherMs }),
      ...(restartAfterMs === undefined ? {} : { restartAfterMs }),
      ...(giveUpMs === undefined ? {} : { giveUpMs }),
    },
    shim,
  };
}

/** Counts every RTCPeerConnection a page makes and keeps them, with the policy each was given, for the script to inspect. Credentials are never kept. */
function installRtcAudit() {
  const Original = window.RTCPeerConnection;
  window.__rtc = [];
  window.__rtcConfigs = [];
  window.RTCPeerConnection = class extends Original {
    constructor(configuration, ...rest) {
      super(configuration, ...rest);
      window.__rtc.push(this);
      window.__rtcConfigs.push({
        policy: configuration?.iceTransportPolicy ?? "all",
        urls: (configuration?.iceServers ?? []).flatMap((server) => [].concat(server.urls)),
      });
    }
  };
}

const rtcCount = (page) => page.evaluate(() => window.__rtc.length);
const rtcConfigs = (page) => page.evaluate(() => window.__rtcConfigs);
async function selectedPair(page, index = 0) {
  return page.evaluate(async (which) => {
    const stats = await window.__rtc[which].getStats();
    const reports = new Map();
    stats.forEach((report) => reports.set(report.id, report));
    let pair;
    for (const report of reports.values()) if (report.type === "transport" && report.selectedCandidatePairId) pair = reports.get(report.selectedCandidatePairId);
    const kind = (id) => reports.get(id)?.candidateType ?? "unknown";
    return pair ? { local: kind(pair.localCandidateId), remote: kind(pair.remoteCandidateId) } : undefined;
  }, index);
}

/** The selected pair is only there while the connection is open, so it is read as the file moves. The last reading wins. */
function watchPath(page, index = 0) {
  const seen = { path: undefined };
  const timer = setInterval(() => {
    selectedPair(page, index).then((path) => { if (path) seen.path = path; }, () => undefined);
  }, 150);
  return { seen, stop: () => clearInterval(timer) };
}

const BROWSER_ARGS = [
  // Show host candidates as addresses, not mDNS names, so two browsers on one machine can reach each other
  // whatever the machine's multicast does. Real phones keep the mDNS names.
  "--disable-features=WebRtcHideLocalIpsWithMdns",
];

/** A Chrome on macOS, where the Playwright browsers are not always installed; Playwright's own Chromium elsewhere. */
function chromeExecutable() {
  return process.env.WILDBLOOM_BROWSER_EXECUTABLE
    ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
}

async function openPhone(link, { colorScheme = "light", device = "Pixel 7" } = {}) {
  const context = await phoneBrowser.newContext({ ...devices[device], acceptDownloads: false, colorScheme });
  contexts.add(context);
  await context.addInitScript(installBrowserPersistenceAudit);
  await context.addInitScript(installRtcAudit);
  await context.addInitScript(() => {
    window.__titles = [];
    window.__notes = [];
    const watch = () => {
      const title = document.getElementById("title");
      if (!title) return false;
      new MutationObserver(() => window.__titles.push(title.textContent)).observe(title, { childList: true, characterData: true, subtree: true });
      new MutationObserver(() => {
        const text = document.getElementById("view")?.innerText ?? "";
        if (/Trying again/u.test(text)) window.__notes.push("reconnecting");
      }).observe(document.getElementById("view"), { childList: true, characterData: true, subtree: true });
      return true;
    };
    if (!watch()) document.addEventListener("DOMContentLoaded", watch);
  });
  // Count what the page asks of the Screen Wake Lock API.
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
  const allowed = new Set([fixtures.appOrigin, fixtures.relayOrigin]);
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
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type()) || message.text().includes("Permissions-Policy header")) return;
    // Polling for the other side's next message answers 404 until it exists; Chrome logs each one.
    if (message.text().includes("status of 404") && message.location().url.startsWith(fixtures.relayOrigin)) return;
    // Chrome reports an unreachable TURN server (the local journeys list one nothing listens on) as a warning.
    if (/STUN\/TURN|ICE|701/u.test(message.text())) return;
    consoleProblems.push(message.text());
  });
  page.on("pageerror", (error) => { pageErrors.push(String(error)); consoleProblems.push(String(error)); });
  await page.goto(link);
  lastPhonePage = page;
  return { context, page, requests, consoleProblems, pageErrors };
}

async function openDrop(session) {
  const context = await dropBrowser.newContext({ acceptDownloads: true });
  contexts.add(context);
  await context.addInitScript(installRtcAudit);
  if (session.shim) {
    await context.exposeBinding("__bridge_proxyFor", (_source, role, ip, port) => session.shim.proxyFor(role, ip, port));
    await context.addInitScript(() => {
      window.__bridge = { proxyFor: (role, ip, port) => window.__bridge_proxyFor(role, ip, port) };
    });
  }
  const page = await context.newPage();
  const consoleProblems = [];
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    if (message.text().includes("status of 404") && message.location().url.startsWith(fixtures.relayOrigin)) return;
    if (/STUN\/TURN|ICE|701/u.test(message.text())) return;
    consoleProblems.push(message.text());
  });
  page.on("pageerror", (error) => consoleProblems.push(String(error)));
  await page.goto(`${fixtures.harnessOrigin}/index.html`);
  await page.evaluate((config) => window.__drop.start(config), session.config);
  return { context, page, consoleProblems };
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

const snapshot = (drop) => drop.page.evaluate(() => window.__drop.snapshot());

/** What each peer connection thinks, for a failure message. Only states and candidate lines; never a credential or a key. */
async function describeRtc(page) {
  return page.evaluate(() => (window.__rtc ?? []).map((pc) => ({
    connection: pc.connectionState,
    ice: pc.iceConnectionState,
    gathering: pc.iceGatheringState,
    local: (pc.localDescription?.sdp ?? "").split("\r\n").filter((line) => line.startsWith("a=candidate")).map((line) => line.split(" ").slice(4, 8).join(" ")),
    remote: (pc.remoteDescription?.sdp ?? "").split("\r\n").filter((line) => line.startsWith("a=candidate")).map((line) => line.split(" ").slice(4, 8).join(" ")),
  }))).catch(() => []);
}
let lastPhonePage;

/** Samples how much the receiver has written, so a send's rate can be read from outside. */
function watchRate(drop) {
  const samples = [];
  const timer = setInterval(() => {
    snapshot(drop).then((now) => samples.push({ t: Date.now(), written: now.written }), () => undefined);
  }, 100);
  return { stop: () => { clearInterval(timer); return samples; } };
}

/** The average rate from the first byte to the last sample, and the most any one second carried. */
function ratesOf(samples) {
  const moving = samples.filter((sample) => sample.written > 0);
  assert.ok(moving.length > 3, "The send was sampled while it moved.");
  const first = moving[0];
  const last = moving.at(-1);
  const average = ((last.written - first.written) / (last.t - first.t)) * 1000;
  let busiest = 0;
  for (let from = 0; from < moving.length; from += 1) {
    const to = moving.findIndex((sample) => sample.t - moving[from].t >= 1000);
    if (to > from) busiest = Math.max(busiest, ((moving[to].written - moving[from].written) / (moving[to].t - moving[from].t)) * 1000);
  }
  return { average, busiest };
}

async function waitDrop(drop, predicate, description, timeout = 30_000, argument) {
  try {
    await drop.page.waitForFunction(predicate, argument, { timeout, polling: 100 });
  } catch (error) {
    const state = await snapshot(drop).catch(() => ({}));
    const rtc = JSON.stringify({ receiver: await describeRtc(drop.page), phone: lastPhonePage ? await describeRtc(lastPhonePage) : undefined });
    throw new Error(`Timed out waiting for ${description}: phase ${state.phase}, failure ${state.failure}, events ${(state.events ?? []).slice(-8).join(" | ")}, peers ${rtc}`, { cause: error });
  }
}

/** Words entered, check words compared and confirmed on both sides. Leaves the phone at "Choose a file". */
async function toChoose(session, phone, drop) {
  await submitWords(phone.page, session.words);
  await expectTitle(phone.page, "Check these words with them");
  await waitDrop(drop, () => window.__drop.snapshot().phase === "check", "the check words");
  const shown = await phone.page.locator(".words-list li").allInnerTexts();
  const theirs = (await snapshot(drop)).checkWords;
  assert.equal(shown.join(" "), theirs, "Both sides show the same check words.");
  await shot(phone.page, "check-words");
  await drop.page.evaluate(() => window.__drop.confirm(true));
  await phone.page.getByRole("button", { name: "Yes, they match" }).click();
  await expectTitle(phone.page, "Choose a file");
}

async function chooseFile(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /^Choose (a|another) file$/u }).click()]);
  await chooser.setFiles(file);
}

async function dropAccepts(drop) {
  await waitDrop(drop, () => window.__drop.snapshot().phase === "manifest", "the manifest");
  await drop.page.evaluate(() => window.__drop.accept());
}

async function savedBytes(drop) {
  const [download] = await Promise.all([drop.page.waitForEvent("download"), drop.page.locator("#save").click()]);
  return readFileSync(await download.path());
}

/** Sparse files, so a 250 MB file costs no disk and no memory to offer. */
function sparseFile(name, bytes) {
  const path = join(temporary, name);
  const descriptor = openSync(path, "w");
  ftruncateSync(descriptor, bytes);
  closeSync(descriptor);
  return path;
}

// --------------------------------------------------------------------- run

try {
  const service = await startPairingService();
  const appPort = await freePort();
  fixtures.appOrigin = `http://127.0.0.1:${appPort}`;
  const harness = await startStatic(join(temporary, "harness"));
  fixtures.harnessOrigin = harness.origin;
  const proxy = await startRelayProxy(service.origin, new Set([fixtures.appOrigin, fixtures.harnessOrigin]));
  fixtures.relayOrigin = proxy.origin;

  const coturnBinary = findCoturn();
  const turnPort = await freePort("udp");
  let relayAvailable = false;
  let relayHow = "";
  if (coturnBinary) {
    await startTurn(coturnBinary, turnPort);
    relayAvailable = true;
    relayHow = "coturn";
  } else if (dockerCoturnAvailable()) {
    await startTurnDocker(turnPort);
    relayAvailable = true;
    relayHow = `coturn in Docker (${DOCKER_IMAGE})`;
  }
  if (relayAvailable) {
    turn = { port: turnPort, urls: [`stun:127.0.0.1:${turnPort}`, `turn:127.0.0.1:${turnPort}?transport=udp`] };
    process.stdout.write(`    relay: ${relayHow}, each allocation capped at ${TURN_MAX_BPS} bytes a second\n`);
  } else {
    // The protocol wants a TURN URL in every invitation. Nothing listens on this port; the host-candidate journeys do not need it.
    turn = { port: turnPort, urls: [`turn:127.0.0.1:${turnPort}?transport=udp`] };
    if (process.env.DIRECT_REQUIRE_TURN === "1") throw new Error("DIRECT_REQUIRE_TURN is set but no coturn (turnserver, or the Docker image) was found.");
  }

  await runVite(["--outDir", join(temporary, "app", "dist"), "--emptyOutDir"], {
    VITE_WILDBLOOM_PAIR_RELAY: `${proxy.origin}/pair/v1/`,
    VITE_WILDBLOOM_DIRECT_ICE: turn.urls.join(","),
  }, "Production");
  await runVite(["--config", "tests/harness/direct-drop/vite.config.ts", "--outDir", join(temporary, "harness"), "--emptyOutDir"], {}, "Test receiver");
  const app = launch(process.execPath, [join(repository, "scripts/serve-production.mjs"), "--port", String(appPort)], { cwd: join(temporary, "app") });
  await waitReady(`${fixtures.appOrigin}/healthz`, app);
  fixtures.grants = kit.createCreationGrantClient({ apiUrl: `${service.origin}/v1/`, allowLoopbackHttp: true });
  fixtures.upstream = kit.createLiveRelayClient({ apiUrl: `${service.origin}/v1/`, allowLoopbackHttp: true });

  const executablePath = chromeExecutable();
  const launchOptions = { headless: true, args: BROWSER_ARGS, ...(executablePath ? { executablePath } : {}) };
  phoneBrowser = await chromium.launch(launchOptions);
  dropBrowser = await chromium.launch(launchOptions);

  await step("journey: Android Chrome sends a file straight to the receiver over host candidates", async () => {
    const session = await newSession();
    const phone = await openPhone(session.link);
    const drop = await openDrop(session);
    await expectTitle(phone.page, "Send a file");
    assert.match(await phone.page.evaluate(() => navigator.userAgent), /Android .*Chrome\/.* Mobile/u, "The page runs as Android Chrome.");
    assert.equal(await rtcCount(phone.page), 0, "Opening the page makes no peer connection.");
    await shot(phone.page, "words");
    await toChoose(session, phone, drop);
    await expectNoOverflow(phone.page, "the choose screen");
    assert.equal(await phone.page.locator("#hide").isChecked(), false, "The phone is direct by default.");
    assert.match(await phone.page.locator("#view").innerText(), /Don't show them my internet address/u);
    await shot(phone.page, "choose");

    const bytes = sample(3 * 1024 * 1024 + 4321);
    await chooseFile(phone.page, { name: "Café holiday.mp4", mimeType: "video/mp4", buffer: bytes });
    await expectTitle(phone.page, "Waiting for them to accept");
    await shot(phone.page, "asking");
    await waitDrop(drop, () => window.__drop.snapshot().phase === "manifest", "the manifest");
    const manifest = (await snapshot(drop)).manifest;
    assert.deepEqual(manifest, { name: "Café holiday.mp4", size: bytes.length, type: "video/mp4" });
    // Neither end has made a peer connection: no address is exposed before the owner accepts.
    assert.equal(await rtcCount(phone.page), 0);
    assert.equal(await rtcCount(drop.page), 0);

    const phonePath = watchPath(phone.page);
    await drop.page.evaluate(() => window.__drop.accept());
    await expectTitle(phone.page, "Sent", 60_000);
    phonePath.stop();
    await shot(phone.page, "sent");
    await waitDrop(drop, () => window.__drop.snapshot().phase === "kept", "KEPT", 30_000);
    const kept = (await snapshot(drop)).kept;
    assert.equal(kept.sha256, sha256(bytes));
    assert.equal(kept.name, "Café holiday.mp4");
    assert.equal(await drop.page.locator("#save").isVisible(), true, "Save is offered only after the file is verified.");
    assert.ok((await savedBytes(drop)).equals(bytes), "The saved file is byte for byte the source.");

    assert.equal(await rtcCount(phone.page), 1);
    assert.equal(await rtcCount(drop.page), 1);
    const [phoneConfig] = await rtcConfigs(phone.page);
    assert.equal(phoneConfig.policy, "all");
    assert.deepEqual(phoneConfig.urls, turn.urls, "The phone uses the invitation's servers and nothing else.");
    const path = phonePath.seen.path;
    assert.ok(path, "The selected path was seen while the file moved.");
    assert.ok(["host", "prflx"].includes(path.local) && ["host", "prflx"].includes(path.remote), `Direct over host candidates, not ${JSON.stringify(path)}.`);
    const wake = await phone.page.evaluate(() => window.__wakeLock);
    assert.ok(wake.requests >= 1, "The page asked to keep the screen on while it sent the file.");
    assert.equal(wake.releases, wake.granted, "The page let the screen sleep again once the file was sent.");
    const titles = await phone.page.evaluate(() => window.__titles);
    for (const expected of ["Waiting for them to accept", "Sent"]) assert.ok(titles.includes(expected), `Saw ${expected} in ${JSON.stringify(titles)}`);
    assert.equal(new URL(phone.page.url()).hash, new URL(session.link).hash, "Nothing was written to the address.");
    await assertNoBrowserPersistence(phone.page, phone.context, "the phone after a send");
    assert.deepEqual(phone.consoleProblems, []);
    assert.deepEqual(drop.consoleProblems, []);
    assert.ok(phone.requests.every((request) => /^(?:GET|POST|PUT|DELETE|OPTIONS) (?:http:\/\/127\.0\.0\.1|data:|blob:)/u.test(request)), "The phone contacted only the page host and the pairing service.");
    await phone.context.close();
    await drop.context.close();
  });

  await step("journey: wrong words end the link and no peer connection is ever made", async () => {
    const session = await newSession();
    const phone = await openPhone(session.link);
    const drop = await openDrop(session);
    const wrong = session.words.split(" ").map((word, index) => (index === 0 ? (word === "zoo" ? "yes" : "zoo") : word)).join(" ");
    await submitWords(phone.page, wrong);
    await expectTitle(phone.page, "Those words didn't work");
    await waitDrop(drop, () => window.__drop.snapshot().phase === "pair-failed", "the pairing to fail");
    assert.equal(await rtcCount(phone.page), 0);
    assert.equal(await rtcCount(drop.page), 0);
    await shot(phone.page, "wrong-words");
    await phone.context.close();
    await drop.context.close();
  });

  await step("journey: check words that do not match send nothing and make no peer connection", async () => {
    const session = await newSession();
    const phone = await openPhone(session.link);
    const drop = await openDrop(session);
    await submitWords(phone.page, session.words);
    await expectTitle(phone.page, "Check these words with them");
    await waitDrop(drop, () => window.__drop.snapshot().phase === "check", "the check words");
    await phone.page.getByRole("button", { name: "No, they don't" }).click();
    await expectTitle(phone.page, "Nothing was sent");
    await drop.page.evaluate(() => window.__drop.confirm(false));
    assert.equal(await rtcCount(phone.page), 0);
    assert.equal(await rtcCount(drop.page), 0);
    assert.equal((await snapshot(drop)).phase, "mismatch");
    await shot(phone.page, "mismatch");
    await phone.context.close();
    await drop.context.close();
  });

  await step("journey: the receiver declines, the phone says so and neither end makes a peer connection", async () => {
    const session = await newSession();
    const phone = await openPhone(session.link);
    const drop = await openDrop(session);
    await toChoose(session, phone, drop);
    // A name that would be drawn with a different extension (an override character before "fdp") reaches the receiver
    // as the plain name it is made of.
    await chooseFile(phone.page, { name: "invoice\u202Efdp.terminal", mimeType: "application/pdf", buffer: sample(50_000) });
    await expectTitle(phone.page, "Waiting for them to accept");
    await waitDrop(drop, () => window.__drop.snapshot().phase === "manifest", "the manifest");
    assert.equal((await snapshot(drop)).manifest.name, "invoicefdp.terminal", "The disguising character did not reach the receiver.");
    await drop.page.evaluate(() => window.__drop.decline());
    await expectTitle(phone.page, "They said no");
    assert.match(await phone.page.locator("#view").innerText(), /Nothing was sent\./u);
    assert.equal(await rtcCount(phone.page), 0);
    assert.equal(await rtcCount(drop.page), 0);
    const wake = await phone.page.evaluate(() => window.__wakeLock);
    assert.equal(wake.releases, wake.granted, "The screen is let go once it is declined.");
    await shot(phone.page, "declined");
    await assertNoBrowserPersistence(phone.page, phone.context, "the phone after a decline");
    await phone.context.close();
    await drop.context.close();
  });

  await step("journey: 250,000,001 bytes are refused before anything is offered, 250,000,000 are offered", async () => {
    const session = await newSession();
    const phone = await openPhone(session.link);
    const drop = await openDrop(session);
    await toChoose(session, phone, drop);
    await chooseFile(phone.page, sparseFile("over.bin", MAX + 1));
    await expectTitle(phone.page, "This file is too big");
    assert.match(await phone.page.locator("#view").innerText(), /You can send up to 250 MB\./u);
    await shot(phone.page, "too-big");
    await sleep(500);
    assert.equal((await snapshot(drop)).phase, "invited", "Nothing was offered to the receiver.");
    await chooseFile(phone.page, sparseFile("empty.bin", 0));
    await expectTitle(phone.page, "That file is empty");
    await chooseFile(phone.page, sparseFile("exactly.bin", MAX));
    await expectTitle(phone.page, "Waiting for them to accept");
    await waitDrop(drop, () => window.__drop.snapshot().phase === "manifest", "the manifest");
    assert.equal((await snapshot(drop)).manifest.size, MAX);
    await drop.page.evaluate(() => window.__drop.decline());
    await expectTitle(phone.page, "They said no");
    assert.equal(await rtcCount(phone.page), 0);
    await phone.context.close();
    await drop.context.close();
  });

  await step("journey: a send in landscape on a phone fits the screen", async () => {
    const session = await newSession();
    const phone = await openPhone(session.link, { device: "Pixel 7 landscape" });
    const drop = await openDrop(session);
    await toChoose(session, phone, drop);
    await expectNoOverflow(phone.page, "the choose screen in landscape");
    await shot(phone.page, "choose-landscape");
    await chooseFile(phone.page, { name: "note.txt", mimeType: "text/plain", buffer: sample(2000) });
    await dropAccepts(drop);
    await expectTitle(phone.page, "Sent", 60_000);
    await expectNoOverflow(phone.page, "the sent screen in landscape");
    await phone.context.close();
    await drop.context.close();
  });

  await step("journey: the phone holds a few records, whatever the size of the file it sends", async () => {
    // Sends a file of this many MiB from a file on disk and returns the most the page kept alive. The page's memory
    // is collected as it goes, so what is measured is what it holds, not what it has yet to throw away: its
    // JavaScript heap and its ArrayBuffer backing stores, where a file read into memory would show.
    async function sendLarge(mebibytes) {
      const session = await newSession();
      const phone = await openPhone(session.link);
      const drop = await openDrop(session);
      await toChoose(session, phone, drop);
      const size = mebibytes * 1024 * 1024;
      const path = join(temporary, `large-${mebibytes}.bin`);
      const descriptor = openSync(path, "w");
      for (let offset = 0; offset < size; offset += 4 * 1024 * 1024) writeFileSync(descriptor, sample(4 * 1024 * 1024, offset / (4 * 1024 * 1024) + 3));
      closeSync(descriptor);
      const expected = sha256(readFileSync(path));
      const cdp = await phone.context.newCDPSession(phone.page);
      const held = async () => {
        await cdp.send("HeapProfiler.collectGarbage");
        const usage = await cdp.send("Runtime.getHeapUsage");
        return usage.usedSize + (usage.backingStorageSize ?? 0);
      };
      const baseline = await held();
      let peak = baseline;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          peak = Math.max(peak, await held().catch(() => 0));
          await sleep(150);
        }
      })();
      await chooseFile(phone.page, path);
      await dropAccepts(drop);
      const started = Date.now();
      await expectTitle(phone.page, "Sent", 240_000);
      sampling = false;
      await sampler;
      await waitDrop(drop, () => window.__drop.snapshot().phase === "kept", "KEPT", 60_000);
      assert.equal((await snapshot(drop)).kept.sha256, expected);
      const seconds = (Date.now() - started) / 1000;
      const growth = peak - baseline;
      process.stdout.write(`    ${mebibytes} MiB in ${seconds.toFixed(1)} s, the phone page held ${(growth / 1048576).toFixed(0)} MiB more than before at most\n`);
      // A direct pair is not paced: far faster than the 400,000 bytes a second a relayed send is held to.
      if (mebibytes >= 96) assert.ok(size / seconds > 1_200_000, `A direct send of ${mebibytes} MiB averaged ${Math.round(size / seconds)} bytes a second.`);
      await phone.context.close();
      await drop.context.close();
      return growth;
    }
    const small = await sendLarge(24);
    const large = await sendLarge(96);
    // A few records are in hand at once, whatever the file: four times the data must not cost four times the memory,
    // and a file read whole would hold more than its own size.
    assert.ok(large < 48 * 1024 * 1024, `The page held ${Math.round(large / 1048576)} MiB more sending 96 MiB.`);
    assert.ok(large - small < 24 * 1024 * 1024, `The page held ${Math.round(small / 1048576)} MiB more for 24 MiB and ${Math.round(large / 1048576)} MiB for 96 MiB.`);
  });

  await step("journey: the connection is cut mid-transfer and the send resumes by an ICE restart", async () => {
    const shim = new PathShim();
    shim.bytesPerSecond = 4 * 1024 * 1024;
    const session = await newSession({ shim, restartAfterMs: 6_000, giveUpMs: 90_000 });
    const phone = await openPhone(session.link);
    const drop = await openDrop(session);
    await toChoose(session, phone, drop);
    const bytes = sample(24 * 1024 * 1024, 5);
    await chooseFile(phone.page, { name: "cut.bin", mimeType: "application/octet-stream", buffer: bytes });
    await dropAccepts(drop);
    await waitDrop(drop, () => window.__drop.snapshot().written > 4 * 1024 * 1024, "a fifth of the file to arrive", 60_000);
    const before = (await snapshot(drop)).written;
    shim.cut = true;
    process.stdout.write("    path cut\n");
    await waitDrop(drop, () => window.__drop.snapshot().restarts >= 1, "an ICE restart", 120_000);
    // The restart travelled over the exchange, not the cut path. Now the path comes back.
    await sleep(500);
    shim.cut = false;
    process.stdout.write("    path restored\n");
    await expectTitle(phone.page, "Sent", 180_000);
    await waitDrop(drop, () => window.__drop.snapshot().phase === "kept", "KEPT", 60_000);
    const after = await snapshot(drop);
    assert.equal(after.kept.sha256, sha256(bytes), "The file is whole after the restart.");
    assert.ok(after.restarts >= 1 && after.restarts <= 5, `Restarts: ${after.restarts}`);
    assert.ok(after.written >= before);
    assert.ok(after.events.some((event) => event.includes("reconnecting")), "The receiver saw the connection drop.");
    assert.ok((await phone.page.evaluate(() => window.__notes)).includes("reconnecting"), "The phone told its person the connection dropped.");
    assert.equal(await rtcCount(phone.page), 1, "One connection throughout: a restart, not a new connection.");
    assert.equal(await rtcCount(drop.page), 1);
    assert.ok(shim.dropped > 0, "The shim cut real packets.");
    process.stdout.write(`    ${after.restarts} ICE restart${after.restarts === 1 ? "" : "s"}, ${shim.dropped} packets dropped while the path was cut\n`);
    await phone.context.close();
    await drop.context.close();
    shim.close();
  });

  await step("journey: the page is left mid-transfer, its stop still reaches the relay, and the receiver keeps nothing", async () => {
    const shim = new PathShim();
    shim.bytesPerSecond = 3 * 1024 * 1024;
    const session = await newSession({ shim });
    const phone = await openPhone(session.link);
    const drop = await openDrop(session);
    await toChoose(session, phone, drop);
    await chooseFile(phone.page, { name: "closing.bin", mimeType: "application/octet-stream", buffer: sample(24 * 1024 * 1024, 9) });
    await dropAccepts(drop);
    await waitDrop(drop, () => window.__drop.snapshot().written > 2 * 1024 * 1024, "the transfer to be under way", 60_000);
    // Leaving the page fires pagehide as closing a tab does, and keeps the browser context alive to watch the relay.
    // The page asks before it is left mid-send; the person chooses to leave.
    const pagePuts = () => relayLog.filter((line) => /^PUT \/pair\/v1\/live-sessions\/[^/]+\/messages\/recipient\/packet-/u.test(line)).length;
    const putsBefore = pagePuts();
    const asked = [];
    phone.page.on("dialog", (dialog) => {
      asked.push(dialog.type());
      void dialog.accept();
    });
    // Playwright's request routing drops a keepalive request that needs a CORS preflight once its page has gone,
    // which the stop does (the relay is another origin). Chrome itself delivers it, so stop routing before leaving.
    // The origin audit still covers everything the page asked for before this point.
    await phone.context.unroute("**/*");
    await phone.page.goto("about:blank");
    assert.deepEqual(asked, ["beforeunload"], "The page asked before it was left mid-send.");
    const deadline = Date.now() + 15_000;
    while (pagePuts() === putsBefore && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(pagePuts(), putsBefore + 1, "The page's stop reached the relay after it left.");
    await waitDrop(drop, () => ["ended", "kept"].includes(window.__drop.snapshot().phase), "the receiver to notice", 90_000);
    const after = await snapshot(drop);
    assert.equal(after.phase, "ended");
    assert.ok(["peer-cancelled", "lost"].includes(after.failure), `The receiver reports ${after.failure}.`);
    assert.equal(after.kept, null);
    assert.equal(after.saveVisible, false, "Nothing can be saved.");
    await phone.context.close();
    await drop.context.close();
    shim.close();
  });

  if (relayAvailable) {
    await step("journey: both ends hide their addresses, so every packet goes through the TURN server", async () => {
      const session = await newSession({ hide: true });
      const phone = await openPhone(session.link);
      const drop = await openDrop(session);
      await toChoose(session, phone, drop);
      await phone.page.locator("#hide").check();
      assert.match(await phone.page.locator("#view").innerText(), /hiding their own internet address/u);
      const bytes = sample(3 * 1024 * 1024 + 5, 11);
      await chooseFile(phone.page, { name: "relayed.bin", mimeType: "application/octet-stream", buffer: bytes });
      await waitDrop(drop, () => window.__drop.snapshot().phase === "manifest", "the manifest");
      const phonePath = watchPath(phone.page);
      const dropPath = watchPath(drop.page);
      const rate = watchRate(drop);
      await drop.page.evaluate(() => window.__drop.accept());
      await expectTitle(phone.page, "Sent", 180_000);
      phonePath.stop();
      dropPath.stop();
      await waitDrop(drop, () => window.__drop.snapshot().phase === "kept", "KEPT");
      const { average, busiest } = ratesOf(rate.stop());
      process.stdout.write(`    relayed: ${Math.round(average)} bytes a second on average, ${Math.round(busiest)} at the busiest second, through a cap of ${TURN_MAX_BPS}\n`);
      assert.equal((await snapshot(drop)).kept.sha256, sha256(bytes));
      // The pair is relayed, so the sender holds itself to 400,000 bytes a second (a little over, for the clock and the burst),
      // and the send neither stalls nor collapses under the server's cap.
      assert.ok(average <= 400_000 * 1.12, `A relayed send averaged ${Math.round(average)} bytes a second.`);
      assert.ok(busiest <= 400_000 + 65_536 + 60_000, `A relayed send carried ${Math.round(busiest)} bytes in one second.`);
      assert.ok(average >= 100_000, `A relayed send averaged only ${Math.round(average)} bytes a second.`);
      for (const [label, page, watched] of [["phone", phone.page, phonePath], ["receiver", drop.page, dropPath]]) {
        const [config] = await rtcConfigs(page);
        assert.equal(config.policy, "relay", `${label} uses the relay-only policy.`);
        assert.ok(config.urls.every((url) => /^turns?:/u.test(url)), `${label} contacts no STUN server: ${config.urls}`);
        assert.equal(watched.seen.path?.local, "relay", `${label}'s selected path is through the TURN server.`);
      }
      await phone.context.close();
      await drop.context.close();
    });
  } else {
    skipped.push("relay-only through TURN");
    process.stdout.write("SKIP journey: both ends hide their addresses (relay-only). coturn is not installed here (no turnserver, and no coturn image for Docker); set COTURN_BIN or install it. CI runs this case.\n");
  }

  assert.deepEqual(violations, [], "No request left the fixture origins.");
  process.stdout.write(`${JSON.stringify({ passed: true, checks: checks.length, skipped })}\n`);
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await phoneBrowser?.close().catch(() => undefined);
  await dropBrowser?.close().catch(() => undefined);
  for (const socket of sockets) try { socket.close(); } catch { /* closed */ }
  for (const server of servers) await closeControlledServer(server).catch(() => undefined);
  for (const child of children) await stopChild(child).catch(() => undefined);
  for (const name of dockerContainers) { try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch { /* gone */ } }
  rmSync(temporary, { recursive: true, force: true });
}
