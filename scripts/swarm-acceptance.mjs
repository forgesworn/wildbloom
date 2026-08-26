import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import TrackerServer from "bittorrent-tracker/server";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";

const HOST = "127.0.0.1";
const SOURCE_BYTES = Buffer.from("Wildbloom peer acceptance\n".repeat(16_384), "utf8");
const SOURCE_HASH = createHash("sha256").update(SOURCE_BYTES).digest("hex");
const SECRET = new Uint8Array(32).fill(17);
const PUBKEY = getPublicKey(SECRET);
const WRONG_RECOVERY_KEY = `wbk1_${Buffer.alloc(32, 99).toString("base64url")}`;
const tempRoot = mkdtempSync(join(tmpdir(), "wildbloom-swarm-"));

function requestedBrowser() {
  const browserArgumentIndex = process.argv.indexOf("--browser");
  const inlineArgument = process.argv.find((argument) => argument.startsWith("--browser="));
  if (browserArgumentIndex >= 0 && !process.argv[browserArgumentIndex + 1]) throw new Error("--browser requires a value.");
  const value = browserArgumentIndex >= 0
    ? process.argv[browserArgumentIndex + 1]
    : inlineArgument?.slice("--browser=".length) ?? process.env.WILDBLOOM_BROWSER ?? "system-chromium";
  if (value !== "system-chromium" && value !== "chromium") throw new Error(`Unsupported swarm browser: ${value}`);
  return value;
}

function findChrome() {
  const operatingSystem = platform();
  const candidates = operatingSystem === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : operatingSystem === "win32"
      ? [
          process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
          process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
          process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
          process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
          process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
        ].filter((candidate) => typeof candidate === "string")
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit browser path.
    }
  }
  throw new Error("Swarm acceptance requires an installed Chrome, Chromium, Brave or Edge executable.");
}

async function availablePort() {
  const reservation = createHttpServer();
  await listen(reservation);
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a production server port.");
  await closeServer(reservation);
  return address.port;
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(port, HOST);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function waitForProduction(processHandle, origin) {
  await waitFor(async () => {
    if (processHandle.exitCode !== null) throw new Error(`Production server exited early with ${processHandle.exitCode}.`);
    try {
      return (await fetch(`${origin}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 10_000, "Timed out waiting for the production server.");
}

function createCertificate() {
  const keyPath = join(tempRoot, "tracker.key");
  const certificatePath = join(tempRoot, "tracker.crt");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
    "-keyout", keyPath,
    "-out", certificatePath,
    "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });
  return { key: readFileSync(keyPath), cert: readFileSync(certificatePath) };
}

let trackerCertificate;
try {
  trackerCertificate = createCertificate();
} catch (error) {
  rmSync(tempRoot, { recursive: true, force: true });
  throw error;
}

function peerCount(tracker, infoHash) {
  return tracker.torrents[infoHash]?.peers.keys.length ?? 0;
}

const relayEvents = new Map();
const relayErrors = [];
const relay = new WebSocketServer({ host: HOST, port: 0, maxPayload: 1024 * 1024 });
relay.on("error", (error) => relayErrors.push(error.message));
relay.on("connection", (socket) => socket.on("message", (raw) => {
  try {
    const message = JSON.parse(raw.toString("utf8"));
    if (message[0] === "EVENT") {
      const event = message[1];
      relayEvents.set(event.id, event);
      socket.send(JSON.stringify(["OK", event.id, true, "stored by controlled relay"]));
    }
    if (message[0] === "REQ") {
      const subscription = message[1];
      const event = relayEvents.get(message[2]?.ids?.[0]);
      if (event) socket.send(JSON.stringify(["EVENT", subscription, event]));
      socket.send(JSON.stringify(["EOSE", subscription]));
    }
  } catch (error) {
    relayErrors.push(error instanceof Error ? error.message : String(error));
  }
}));

let blossomOrigin;
let uploadedBytes;
let uploadedHash;
let webSeedAttempts = 0;
const blossomErrors = [];
const blossom = createHttpServer((request, response) => {
  void (async () => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Cache-Control, Content-Type, Range, X-SHA-256",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    };
    const url = new URL(request.url ?? "/", blossomOrigin ?? `http://${HOST}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method === "PUT" && url.pathname === "/upload") {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 4 * 1024 * 1024) throw new Error("Controlled Blossom upload exceeded its acceptance cap.");
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      if (body.length === 0) throw new Error("Browser upload omitted its request body.");
      if (body.includes(SOURCE_BYTES)) throw new Error("Browser upload exposed plaintext source bytes.");
      const hash = createHash("sha256").update(body).digest("hex");
      if (request.headers["x-sha-256"] !== hash) throw new Error("Browser upload sent the wrong X-SHA-256.");
      if (request.headers["content-type"] !== "application/vnd.wildbloom.encrypted") throw new Error("Browser upload exposed the source MIME type.");
      if (!request.headers.authorization?.startsWith("Nostr ")) throw new Error("Browser upload omitted Blossom authorisation.");
      uploadedBytes = body;
      uploadedHash = hash;
      response.writeHead(201, { ...cors, "Content-Type": "application/json" });
      response.end(JSON.stringify({
        url: `${blossomOrigin}/${hash}.wbenc`,
        sha256: hash,
        size: body.length,
        type: "application/vnd.wildbloom.encrypted",
        uploaded: 1_700_000_000,
      }));
      return;
    }
    if (request.method === "GET" && uploadedHash && url.pathname === `/${uploadedHash}.wbenc`) {
      webSeedAttempts += 1;
      response.writeHead(503, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Web seed deliberately unavailable during peer acceptance");
      return;
    }
    response.writeHead(404, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  })().catch((error) => {
    blossomErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Controlled Blossom failure");
  });
});

const trackerErrors = [];
const trackerEvents = [];
const tracker = new TrackerServer({ http: false, udp: false, ws: { noServer: true }, stats: false, interval: 30_000 });
tracker.on("error", (error) => trackerErrors.push(error.message));
tracker.on("warning", (error) => trackerErrors.push(error.message));
for (const event of ["start", "complete", "stop", "update"]) {
  tracker.on(event, (_address, parameters) => trackerEvents.push({ event, infoHash: parameters.info_hash }));
}
const secureTracker = createHttpsServer(trackerCertificate);
secureTracker.on("upgrade", (request, socket, head) => {
  if (new URL(request.url ?? "/", `https://${HOST}`).pathname !== "/announce") {
    socket.destroy();
    return;
  }
  tracker.ws.handleUpgrade(request, socket, head, (websocket) => tracker.ws.emit("connection", websocket, request));
});

const pages = [];
async function createAuditedPage(context, label, origin, allowedOrigins) {
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  const webSockets = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => webSockets.push(socket.url()));
  page.on("request", (request) => {
    const requestOrigin = new URL(request.url()).origin;
    if (!allowedOrigins.has(requestOrigin)) requests.push(`${request.method()} ${request.url()}`);
  });
  await page.exposeFunction("__wildbloomGetPublicKey", () => PUBKEY);
  await page.exposeFunction("__wildbloomSignEvent", (template) => finalizeEvent(template, SECRET));
  await page.addInitScript(() => {
    Object.defineProperty(window, "nostr", {
      configurable: false,
      value: {
        getPublicKey: () => window.__wildbloomGetPublicKey(),
        signEvent: (template) => window.__wildbloomSignEvent(template),
      },
    });
    const evidence = { configurations: [], candidates: [], states: [] };
    Object.defineProperty(window, "__wildbloomPeerEvidence", { configurable: false, value: evidence });
    const NativePeerConnection = window.RTCPeerConnection;
    class AuditedPeerConnection extends NativePeerConnection {
      constructor(configuration, constraints) {
        super(configuration, constraints);
        evidence.configurations.push(configuration ? JSON.parse(JSON.stringify(configuration)) : null);
        this.addEventListener("icecandidate", (event) => {
          if (!event.candidate) return;
          const candidateType = event.candidate.type ?? / typ ([a-z]+)/u.exec(event.candidate.candidate)?.[1] ?? "unknown";
          evidence.candidates.push({ type: candidateType, protocol: event.candidate.protocol ?? "unknown" });
        });
        this.addEventListener("connectionstatechange", () => evidence.states.push(this.connectionState));
      }
    }
    Object.defineProperty(window, "RTCPeerConnection", { configurable: false, value: AuditedPeerConnection });
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  const record = { label, page, errors, requests, webSockets };
  pages.push(record);
  return record;
}

function assertCleanPage(record) {
  if (record.errors.length > 0) throw new Error(`${record.label} browser errors: ${record.errors.join("; ")}`);
  if (record.requests.length > 0) throw new Error(`${record.label} made undeclared requests: ${record.requests.join("; ")}`);
}

function assertPeerEvidence(record) {
  return record.page.evaluate(() => window.__wildbloomPeerEvidence).then((evidence) => {
    if (evidence.configurations.length === 0) throw new Error(`${record.label} did not create a WebRTC peer connection.`);
    for (const configuration of evidence.configurations) {
      if (JSON.stringify(configuration?.iceServers ?? []) !== "[]") {
        throw new Error(`${record.label} created a peer connection with an undeclared ICE service.`);
      }
    }
    if (!evidence.candidates.some((candidate) => candidate.type === "host")) {
      throw new Error(`${record.label} did not gather a host ICE candidate.`);
    }
    const nonHost = evidence.candidates.filter((candidate) => candidate.type !== "host");
    if (nonHost.length > 0) throw new Error(`${record.label} gathered non-host ICE candidates: ${JSON.stringify(nonHost)}`);
    if (!evidence.states.includes("connected")) throw new Error(`${record.label} never reached a connected WebRTC state.`);
  });
}

let browser;
let publisherContext;
let downloaderContext;
let production;
try {
  await Promise.all([listen(blossom), new Promise((resolve, reject) => {
    relay.once("listening", resolve);
    relay.once("error", reject);
  }), listen(secureTracker)]);
  const blossomAddress = blossom.address();
  const relayAddress = relay.address();
  const trackerAddress = secureTracker.address();
  if (!blossomAddress || typeof blossomAddress === "string") throw new Error("Controlled Blossom server did not expose a port.");
  if (!relayAddress || typeof relayAddress === "string") throw new Error("Controlled relay did not expose a port.");
  if (!trackerAddress || typeof trackerAddress === "string") throw new Error("Controlled tracker did not expose a port.");
  blossomOrigin = `http://${HOST}:${blossomAddress.port}`;
  const relayUrl = `ws://${HOST}:${relayAddress.port}`;
  const trackerUrl = `wss://${HOST}:${trackerAddress.port}/announce`;
  const productionPort = await availablePort();
  const origin = `http://${HOST}:${productionPort}`;
  production = spawn(process.execPath, ["scripts/serve-production.mjs", "--host", HOST, "--port", String(productionPort)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForProduction(production, origin);

  const browserName = requestedBrowser();
  browser = await chromium.launch(browserName === "chromium"
    ? { headless: true }
    : { headless: true, executablePath: findChrome() });
  publisherContext = await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  downloaderContext = await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  const allowedOrigins = new Set([origin, blossomOrigin]);
  const publisher = await createAuditedPage(publisherContext, "publisher", origin, allowedOrigins);
  const downloader = await createAuditedPage(downloaderContext, "downloader", origin, allowedOrigins);
  if (publisher.requests.length > 0 || downloader.requests.length > 0) {
    throw new Error(`Opening the two production pages made ambient requests: ${[...publisher.requests, ...downloader.requests].join("; ")}`);
  }

  await publisher.page.fill("#blossom-server", blossomOrigin);
  await publisher.page.fill("#relay-urls", relayUrl);
  await publisher.page.fill("#tracker-urls", trackerUrl);
  await publisher.page.click("#connect-signer");
  await publisher.page.setInputFiles("#publish-file", {
    name: "peer-proof.txt",
    mimeType: "text/plain",
    buffer: SOURCE_BYTES,
  });
  await publisher.page.click("#inspect-file");
  await publisher.page.locator("#publish-status").filter({ hasText: "Encrypted transfer payload prepared" }).waitFor();
  const recoveryKey = await publisher.page.inputValue("#recovery-key-output");
  await publisher.page.check("#upload-consent");
  await publisher.page.check("#key-saved-consent");
  await publisher.page.click("#upload-file");
  await publisher.page.locator("#publish-status").filter({ hasText: "hybrid metadata is staged" }).waitFor();
  const facts = await publisher.page.locator("#file-facts").textContent();
  const infoHash = /Info hash([0-9a-f]{40})/u.exec(facts ?? "")?.[1];
  if (!infoHash || !uploadedBytes || !uploadedHash) throw new Error("Publisher did not stage a controlled encrypted torrent.");
  await publisher.page.check("#seed-consent");
  await publisher.page.click("#start-seeding");
  await publisher.page.locator("#publish-status").filter({ hasText: `Seeding ${infoHash}` }).waitFor({ timeout: 30_000 });
  await publisher.page.click("#sign-events");
  await publisher.page.locator("#publish-status").filter({ hasText: "Signed locally through NIP-07" }).waitFor();
  const signedStatus = await publisher.page.locator("#publish-status").textContent();
  const eventId = /1063: ([0-9a-f]{64})/u.exec(signedStatus ?? "")?.[1];
  if (!eventId) throw new Error("Publisher did not expose the signed NIP-94 event ID.");
  await publisher.page.check("#publish-consent");
  await publisher.page.click("#publish-events");
  await publisher.page.locator("#publish-status").filter({ hasText: "2/2 acknowledgements" }).waitFor();

  await downloader.page.fill("#blossom-server", blossomOrigin);
  await downloader.page.fill("#relay-urls", relayUrl);
  await downloader.page.fill("#tracker-urls", trackerUrl);
  await downloader.page.fill("#event-id", eventId);
  await downloader.page.click("#resolve-event");
  await downloader.page.locator("#retrieve-status").filter({ hasText: "separately received recovery key" }).waitFor();
  await downloader.page.fill("#recovery-key-input", WRONG_RECOVERY_KEY);
  await downloader.page.check("#download-swarm-consent");
  await downloader.page.click("#fetch-swarm");
  await downloader.page.locator("#retrieve-status").filter({ hasText: "wrong or the encrypted envelope was modified" }).waitFor({ timeout: 60_000 });
  await waitFor(
    () => peerCount(tracker, infoHash) === 1,
    10_000,
    "A failed recovery key left the downloading browser in the swarm.",
  );
  if ((await downloader.page.locator("#retrieve-links a").count()) !== 0
    || !(await downloader.page.isEnabled("#fetch-swarm"))) {
    throw new Error("Failed peer decryption retained output or blocked a clean retry.");
  }

  await downloader.page.fill("#recovery-key-input", recoveryKey);
  await downloader.page.click("#fetch-swarm");
  await downloader.page.locator("#retrieve-status").filter({ hasText: "Swarm ciphertext" }).waitFor({ timeout: 60_000 });
  const downloadPromise = downloader.page.waitForEvent("download");
  await downloader.page.getByRole("link", { name: "Save verified peer-proof.txt" }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (!downloadedPath || !readFileSync(downloadedPath).equals(SOURCE_BYTES)) {
    throw new Error("Peer retrieval did not recover the exact source bytes.");
  }
  if (SOURCE_HASH !== createHash("sha256").update(readFileSync(downloadedPath)).digest("hex")) {
    throw new Error("Peer retrieval did not preserve the source SHA-256.");
  }

  await waitFor(() => peerCount(tracker, infoHash) >= 2, 10_000, "The controlled tracker never observed two live browser peers.");
  const starts = trackerEvents.filter((entry) => entry.event === "start" && entry.infoHash === infoHash);
  if (starts.length < 3) throw new Error("The controlled WSS tracker did not receive the publisher, failed-key and retry start announcements.");
  if (!publisher.webSockets.includes(trackerUrl) || !downloader.webSockets.includes(trackerUrl)) {
    throw new Error("Both browsers did not connect to the exact controlled WSS tracker.");
  }
  await Promise.all([assertPeerEvidence(publisher), assertPeerEvidence(downloader)]);
  assertCleanPage(publisher);
  assertCleanPage(downloader);
  if (blossomErrors.length > 0) throw new Error(`Controlled Blossom errors: ${blossomErrors.join("; ")}`);
  if (relayErrors.length > 0) throw new Error(`Controlled relay errors: ${relayErrors.join("; ")}`);
  if (trackerErrors.length > 0) throw new Error(`Controlled tracker errors: ${trackerErrors.join("; ")}`);

  await downloader.page.uncheck("#download-swarm-consent");
  await downloader.page.locator("#retrieve-status").filter({ hasText: "Swarm participation stopped" }).waitFor({ timeout: 10_000 });
  await waitFor(() => peerCount(tracker, infoHash) <= 1, 10_000, "Withdrawing swarm consent did not stop the downloading peer.");
  if (await downloader.page.isChecked("#download-swarm-consent") || await downloader.page.isEnabled("#fetch-swarm")) {
    throw new Error("Withdrawing swarm consent retained peer-download authority.");
  }

  await publisher.page.setInputFiles("#publish-file", {
    name: "replacement.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("replacement", "utf8"),
  });
  await waitFor(() => peerCount(tracker, infoHash) === 0, 10_000, "Changing the source did not stop the publishing peer.");
  if (await publisher.page.isChecked("#seed-consent") || await publisher.page.isEnabled("#start-seeding")) {
    throw new Error("Changing the source retained stale swarm authority.");
  }
  await downloaderContext.close();
  downloaderContext = undefined;
  if (peerCount(tracker, infoHash) !== 0) throw new Error("Closing the downloader restored a withdrawn peer session.");

  process.stdout.write(
    `Swarm acceptance passed in ${browserName}: two isolated production pages transferred and recovered ${SOURCE_BYTES.length} source bytes through the exact controlled WSS tracker with an unavailable web seed, host-only ICE and confirmed peer cleanup after failed decryption, consent withdrawal and source change (${webSeedAttempts} refused web-seed requests).\n`,
  );
} catch (error) {
  const diagnostics = [];
  for (const record of pages) {
    const peerEvidence = await record.page.evaluate(() => window.__wildbloomPeerEvidence).catch(() => null);
    const candidateCounts = peerEvidence?.candidates.reduce((counts, candidate) => {
      const key = `${candidate.type}/${candidate.protocol}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}) ?? null;
    diagnostics.push({
      label: record.label,
      errors: record.errors,
      requests: record.requests,
      webSockets: record.webSockets,
      publishStatus: await record.page.locator("#publish-status").textContent().catch(() => null),
      retrieveStatus: await record.page.locator("#retrieve-status").textContent().catch(() => null),
      peerEvidence: peerEvidence ? {
        connectionCount: peerEvidence.configurations.length,
        configurations: [...new Set(peerEvidence.configurations.map((configuration) => JSON.stringify(configuration)))],
        candidateCounts,
        states: [...new Set(peerEvidence.states)],
      } : null,
    });
  }
  const trackerEventCounts = trackerEvents.reduce((counts, entry) => {
    counts[entry.event] = (counts[entry.event] ?? 0) + 1;
    return counts;
  }, {});
  process.stderr.write(`Swarm acceptance diagnostics: ${JSON.stringify({ diagnostics, trackerEventCounts, trackerErrors, relayErrors, blossomErrors, webSeedAttempts })}\n`);
  throw error;
} finally {
  if (downloaderContext) await downloaderContext.close().catch(() => undefined);
  if (publisherContext) await publisherContext.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  await new Promise((resolve) => tracker.close(resolve));
  await closeServer(secureTracker).catch(() => undefined);
  await closeServer(relay).catch(() => undefined);
  await closeServer(blossom).catch(() => undefined);
  if (production) production.kill("SIGTERM");
  rmSync(tempRoot, { recursive: true, force: true });
}
