import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import TrackerServer from "bittorrent-tracker/server";
import { WebSocketServer } from "ws";
import { WebDriverBiDi } from "./webdriver-bidi.mjs";

const HOST = "127.0.0.1";
const ACTION_TIMEOUT_MS = 30_000;
const PEER_TIMEOUT_MS = 60_000;
const SOURCE_BYTES = Buffer.from("genuine Firefox exact recovery", "utf8");
const PREPARED_BYTES = Buffer.from("prepared in genuine Firefox", "utf8");
const SECRET = new Uint8Array(32).fill(23);
const PUBKEY = getPublicKey(SECRET);
const WRONG_RECOVERY_KEY = `wbk1_${Buffer.alloc(32, 99).toString("base64url")}`;
const tempRoot = mkdtempSync(join(tmpdir(), "wildbloom-firefox-"));

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

async function makeIndependentFixture(blossomOrigin) {
  const metadata = Buffer.from(JSON.stringify({
    name: "branded-firefox.txt",
    size: SOURCE_BYTES.length,
    type: "text/plain",
  }), "utf8");
  const plaintext = randomBytes(64 * 1024);
  plaintext.writeUInt32BE(metadata.length, 0);
  metadata.copy(plaintext, 4);
  SOURCE_BYTES.copy(plaintext, 4 + metadata.length);
  const noncePrefix = randomBytes(8);
  const header = Buffer.alloc(24);
  header.write("WBLMENC1", 0, "ascii");
  header.writeUInt32BE(1024 * 1024, 8);
  header.writeUInt32BE(1, 12);
  noncePrefix.copy(header, 16);
  const nonce = Buffer.alloc(12);
  noncePrefix.copy(nonce);
  const additionalData = Buffer.alloc(28);
  header.copy(additionalData);
  const rawKey = randomBytes(32);
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = Buffer.from(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData,
    tagLength: 128,
  }, key, plaintext));
  plaintext.fill(0);
  const encrypted = Buffer.concat([header, ciphertext]);
  const hash = createHash("sha256").update(encrypted).digest("hex");
  const recoveryKey = `wbk1_${rawKey.toString("base64url")}`;
  rawKey.fill(0);
  const url = `${blossomOrigin}/${hash}.wbenc`;
  const event = finalizeEvent({
    kind: 1063,
    created_at: 1_700_000_000,
    tags: [
      ["url", url],
      ["m", "application/vnd.wildbloom.encrypted"],
      ["x", hash],
      ["ox", hash],
      ["size", String(encrypted.length)],
      ["encryption", "wildbloom-aes-256-gcm-chunked-v1"],
      ["alt", "Encrypted Wildbloom file"],
    ],
    content: "wildbloom.wbenc",
  }, SECRET);
  return { encrypted, event, hash, recoveryKey };
}

function executable(candidates, label) {
  for (const candidate of candidates.filter((value) => typeof value === "string")) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit path.
    }
  }
  throw new Error(`${label} was not found. Set WILDBLOOM_FIREFOX_PATH explicitly.`);
}

function findFirefox() {
  const candidates = platform() === "darwin"
    ? [process.env.WILDBLOOM_FIREFOX_PATH, "/Applications/Firefox.app/Contents/MacOS/firefox"]
    : platform() === "linux"
      ? [process.env.WILDBLOOM_FIREFOX_PATH, "/usr/bin/firefox", "/usr/local/bin/firefox"]
      : [];
  const binary = executable(candidates, "Branded Mozilla Firefox");
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const output = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim();
  if (version.status !== 0 || !/Mozilla Firefox [0-9]/u.test(output)) {
    throw new Error(`The selected browser did not identify as Mozilla Firefox: ${output || "no version output"}`);
  }
  return { binary, version: output };
}

async function listen(server) {
  if (server.listening) return;
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, HOST);
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function availablePort() {
  const server = createServer();
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port.");
  const { port } = address;
  await closeServer(server);
  return port;
}

async function waitFor(predicate, milliseconds, message, intervalMs = 100) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(typeof message === "function" ? message() : message);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

function requestAllowed(request, allowedOrigins) {
  const actual = new URL(request);
  return [...allowedOrigins].some((origin) => {
    const allowed = new URL(origin);
    if (actual.hostname !== allowed.hostname || actual.port !== allowed.port) return false;
    if (actual.protocol === allowed.protocol) return true;
    return (actual.protocol === "http:" && allowed.protocol === "ws:")
      || (actual.protocol === "https:" && allowed.protocol === "wss:");
  });
}

async function evaluate(record, expression, timeoutMs) {
  return record.bidi.evaluateJson(record.context, expression, timeoutMs);
}

async function click(record, selector) {
  const literal = JSON.stringify(selector);
  return evaluate(record, `(() => {
    const element = document.querySelector(${literal});
    if (!(element instanceof HTMLElement)) throw new Error("Missing control: " + ${literal});
    if ("disabled" in element && element.disabled) throw new Error("Disabled control: " + ${literal});
    element.click();
    return true;
  })()`);
}

async function setValue(record, selector, value) {
  const selectorLiteral = JSON.stringify(selector);
  const valueLiteral = JSON.stringify(value);
  return evaluate(record, `(() => {
    const element = document.querySelector(${selectorLiteral});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error("Missing value control: " + ${selectorLiteral});
    }
    element.value = ${valueLiteral};
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return element.value;
  })()`);
}

async function setChecked(record, selector, checked) {
  const selectorLiteral = JSON.stringify(selector);
  return evaluate(record, `(() => {
    const element = document.querySelector(${selectorLiteral});
    if (!(element instanceof HTMLInputElement)) throw new Error("Missing checkable control: " + ${selectorLiteral});
    if (element.disabled) throw new Error("Disabled checkable control: " + ${selectorLiteral});
    if (element.checked !== ${Boolean(checked)}) element.click();
    if (element.checked !== ${Boolean(checked)}) throw new Error("Checkable control did not change: " + ${selectorLiteral});
    return element.checked;
  })()`);
}

async function snapshot(record, selector) {
  const literal = JSON.stringify(selector);
  return evaluate(record, `(() => {
    const element = document.querySelector(${literal});
    if (!(element instanceof HTMLElement)) return null;
    return {
      disabled: "disabled" in element ? Boolean(element.disabled) : false,
      error: element.classList.contains("error"),
      hidden: element.hidden,
      links: element.querySelectorAll("a").length,
      text: element.textContent ?? "",
    };
  })()`);
}

async function waitForText(record, selector, pattern, timeoutMs = ACTION_TIMEOUT_MS) {
  let latest = "";
  await waitFor(async () => {
    latest = (await snapshot(record, selector))?.text ?? "";
    return pattern.test(latest);
  }, timeoutMs, () => `${record.label} did not show ${pattern}; latest text was ${JSON.stringify(latest)}.`);
}

async function waitForUnsignedTemplate(record, expectedKind) {
  let latest = null;
  await waitFor(async () => {
    try {
      latest = await evaluate(record, `(() => {
        const panel = document.querySelector("#external-signing-panel");
        const field = document.querySelector("#external-unsigned-event");
        if (!(panel instanceof HTMLElement) || panel.hidden || !(field instanceof HTMLTextAreaElement) || !field.value) return null;
        return JSON.parse(field.value);
      })()`);
      return latest?.kind === expectedKind;
    } catch {
      return false;
    }
  }, ACTION_TIMEOUT_MS, () => `${record.label} did not expose unsigned kind ${expectedKind}: ${JSON.stringify(latest)}.`);
  return latest;
}

async function completeExternalSignature(record, expectedKind) {
  const template = await waitForUnsignedTemplate(record, expectedKind);
  const signed = finalizeEvent(template, SECRET);
  await setValue(record, "#external-signed-event", JSON.stringify(signed));
  await click(record, "#accept-external-signature");
  return signed;
}

async function launchFirefox(firefox, appOrigin, allowedOrigins, ceremony) {
  const profileDirectory = join(tempRoot, `profile-${ceremony}`);
  mkdirSync(profileDirectory, { mode: 0o700 });
  writeFileSync(join(profileDirectory, "user.js"), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.page", 0);',
    'user_pref("browser.startup.homepage", "about:blank");',
    'user_pref("browser.newtabpage.enabled", false);',
  ].join("\n") + "\n", { mode: 0o600 });
  const remotePort = await availablePort();
  let output = "";
  const processHandle = spawn(firefox.binary, [
    "--headless",
    "--no-remote",
    "--profile", profileDirectory,
    "--remote-debugging-port", String(remotePort),
    "about:blank",
  ], {
    env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const recordOutput = (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-128 * 1024); };
  processHandle.stdout.on("data", recordOutput);
  processHandle.stderr.on("data", recordOutput);

  let bidi;
  await waitFor(async () => {
    if (processHandle.exitCode !== null) throw new Error(`Mozilla Firefox exited before WebDriver BiDi opened: ${output}`);
    try {
      bidi = await WebDriverBiDi.connect(`ws://localhost:${remotePort}/session`, 1_000);
      return true;
    } catch {
      return false;
    }
  }, ACTION_TIMEOUT_MS, () => `Mozilla Firefox did not expose loopback WebDriver BiDi: ${output}`, 250);
  if (!bidi) throw new Error("Mozilla Firefox BiDi connection disappeared.");

  const created = await bidi.command("session.new", { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
  const expectedEngine = /Firefox ([0-9.]+)/u.exec(firefox.version)?.[1];
  if (!expectedEngine || created.capabilities?.browserVersion !== expectedEngine) {
    throw new Error(`Firefox capability version ${created.capabilities?.browserVersion ?? "missing"} did not match ${firefox.version}.`);
  }
  await bidi.command("session.subscribe", { events: ["network.beforeRequestSent"] });
  await bidi.command("script.addPreloadScript", {
    functionDeclaration: `() => {
      window.__wildbloomFirefoxWebRtcUsed = false;
      const peerEvidence = { configurations: [], candidates: [], states: [] };
      Object.defineProperty(window, "__wildbloomPeerEvidence", { configurable: false, value: peerEvidence });
      window.__wildbloomPageErrors = [];
      window.addEventListener("error", (event) => {
        window.__wildbloomPageErrors.push(event.error?.message ?? event.message ?? "unknown page error");
      });
      window.addEventListener("unhandledrejection", (event) => {
        window.__wildbloomPageErrors.push(event.reason?.message ?? String(event.reason ?? "unknown rejected promise"));
      });
      const objectUrls = new Map();
      Object.defineProperty(window, "__wildbloomObservedObjectUrls", { configurable: false, value: objectUrls });
      const createObjectUrl = URL.createObjectURL.bind(URL);
      const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        const url = createObjectUrl(object);
        objectUrls.set(url, object);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        objectUrls.delete(url);
        revokeObjectUrl(url);
      };
      const NativePeerConnection = window.RTCPeerConnection;
      if (typeof NativePeerConnection !== "function") return;
      Object.defineProperty(window, "RTCPeerConnection", {
        configurable: false,
        value: class ObservedPeerConnection extends NativePeerConnection {
          constructor(configuration, constraints) {
            super(configuration, constraints);
            window.__wildbloomFirefoxWebRtcUsed = true;
            peerEvidence.configurations.push(configuration ? JSON.parse(JSON.stringify(configuration)) : null);
            this.addEventListener("icecandidate", (event) => {
              if (!event.candidate) return;
              if (!event.candidate.candidate && !event.candidate.type) return;
              const candidateType = event.candidate.type ?? / typ ([a-z]+)/u.exec(event.candidate.candidate)?.[1] ?? "unknown";
              peerEvidence.candidates.push({
                type: candidateType,
                protocol: event.candidate.protocol ?? "unknown",
              });
            });
            this.addEventListener("connectionstatechange", () => peerEvidence.states.push(this.connectionState));
          }
        },
      });
    }`,
  });
  const { context } = await bidi.command("browsingContext.create", { type: "tab" });
  const requests = [];
  bidi.onEvent((event) => {
    if (event.method === "network.beforeRequestSent" && event.params?.context === context) {
      requests.push(event.params.request?.url ?? "missing request URL");
    }
  });
  const record = {
    bidi,
    context,
    label: `${firefox.version} ${ceremony}`,
    output: () => output,
    process: processHandle,
    requests,
  };
  await bidi.command("browsingContext.navigate", { context, url: appOrigin, wait: "complete" }, ACTION_TIMEOUT_MS);
  const ready = await evaluate(record, `(() => ({
    marker: Boolean(document.querySelector("#inspect-file")),
    origin: location.origin,
    secureContext: window.isSecureContext,
    subtleCrypto: Boolean(window.crypto?.subtle),
    userAgent: navigator.userAgent,
  }))()`);
  const expectedUserAgent = new RegExp(`Firefox/${expectedEngine.split(".")[0]}\\.0`, "u");
  if (!ready.marker || ready.origin !== appOrigin || !ready.secureContext || !ready.subtleCrypto
    || !expectedUserAgent.test(ready.userAgent)) {
    throw new Error(`Mozilla Firefox did not load the exact trustworthy app origin: ${JSON.stringify(ready)}.`);
  }
  for (const request of requests) {
    const url = new URL(request);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !requestAllowed(request, allowedOrigins)) {
      throw new Error(`Mozilla Firefox made an undeclared application request to ${request}.`);
    }
  }
  return record;
}

async function closeFirefox(record) {
  if (!record) return;
  await record.bidi.close().catch(() => undefined);
  await stopChild(record.process);
}

function peerCount(tracker, infoHash) {
  return tracker.torrents[infoHash]?.peers.keys.length ?? 0;
}

async function assertPeerEvidence(record) {
  const evidence = await evaluate(record, "window.__wildbloomPeerEvidence");
  if (evidence.configurations.length === 0) {
    throw new Error(`${record.label} did not create a WebRTC peer connection.`);
  }
  for (const configuration of evidence.configurations) {
    if (JSON.stringify(configuration?.iceServers ?? []) !== "[]") {
      throw new Error(`${record.label} created a peer connection with an undeclared ICE service.`);
    }
  }
  if (!evidence.candidates.some((candidate) => candidate.type === "host")) {
    throw new Error(`${record.label} did not gather a host ICE candidate.`);
  }
  const nonHost = evidence.candidates.filter((candidate) => candidate.type !== "host");
  if (nonHost.length > 0) {
    throw new Error(`${record.label} gathered non-host ICE candidates: ${JSON.stringify(nonHost)}.`);
  }
  if (!evidence.states.includes("connected")) {
    throw new Error(`${record.label} never reached a connected WebRTC state.`);
  }
}

function assertAllowedRequests(record, allowedOrigins) {
  for (const request of record.requests) {
    const url = new URL(request);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !requestAllowed(request, allowedOrigins)) {
      throw new Error(`${record.label} made an undeclared application request to ${request}.`);
    }
  }
}

let blossomMode = "normal";
let publishedRetrievalDenied = false;
let webSeedAttempts = 0;
let hangingStarted = 0;
let hangingClosed = 0;
let encryptedBytes;
let encryptedHash;
let publishedBytes;
let publishedHash;
const uploadAuthorisations = [];
const blossomErrors = [];
const blossomRequests = [];
const blossom = createServer((request, response) => {
  void (async () => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-SHA-256",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    };
    const url = new URL(request.url ?? "/", "http://localhost");
    blossomRequests.push(`${request.method} ${url.pathname}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method === "PUT" && url.pathname === "/upload") {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (body.length === 0 || body.includes(PREPARED_BYTES)) throw new Error("Mozilla Firefox upload omitted ciphertext or exposed source bytes.");
      const hash = createHash("sha256").update(body).digest("hex");
      if (request.headers["x-sha-256"] !== hash
        || request.headers["content-type"] !== "application/vnd.wildbloom.encrypted") {
        throw new Error("Mozilla Firefox upload changed its encrypted payload facts.");
      }
      const authorisation = request.headers.authorization;
      if (!authorisation?.startsWith("Nostr ")) throw new Error("Mozilla Firefox upload omitted Nostr authority.");
      const event = JSON.parse(Buffer.from(authorisation.slice(6), "base64url").toString("utf8"));
      const expiration = Number(event.tags?.find((tag) => tag[0] === "expiration")?.[1]);
      if (!verifyEvent(event)
        || event.pubkey !== PUBKEY
        || expiration - event.created_at !== 300
        || !event.tags.some((tag) => tag[0] === "server" && tag[1] === HOST)
        || !event.tags.some((tag) => tag[0] === "x" && tag[1] === hash)) {
        throw new Error("Mozilla Firefox upload authority was not an exact five-minute external signature.");
      }
      uploadAuthorisations.push(event);
      publishedBytes = body;
      publishedHash = hash;
      const origin = `http://${request.headers.host}`;
      response.writeHead(201, { ...cors, "Content-Type": "application/json" });
      response.end(JSON.stringify({
        url: `${origin}/${hash}.wbenc`,
        sha256: hash,
        size: body.length,
        type: "application/vnd.wildbloom.encrypted",
        uploaded: 1_700_000_000,
      }));
      return;
    }
    const selectedBytes = url.pathname === `/${encryptedHash}.wbenc`
      ? encryptedBytes
      : url.pathname === `/${publishedHash}.wbenc`
        ? publishedBytes
        : undefined;
    if (request.method === "GET" && selectedBytes) {
      if (url.pathname === `/${publishedHash}.wbenc` && publishedRetrievalDenied) {
        webSeedAttempts += 1;
        response.writeHead(503, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
        response.end("Web seed deliberately unavailable during genuine Firefox peer acceptance");
        return;
      }
      if (blossomMode === "hanging") {
        hangingStarted += 1;
        let counted = false;
        const countClosure = () => {
          if (counted) return;
          counted = true;
          hangingClosed += 1;
        };
        request.once("aborted", countClosure);
        response.once("close", () => {
          if (!response.writableEnded) countClosure();
        });
        response.writeHead(200, {
          ...cors,
          "Content-Length": String(selectedBytes.length),
          "Content-Type": "application/vnd.wildbloom.encrypted",
        });
        response.write(selectedBytes.subarray(0, 1024));
        return;
      }
      response.writeHead(200, {
        ...cors,
        "Content-Length": String(selectedBytes.length),
        "Content-Type": "application/vnd.wildbloom.encrypted",
      });
      response.end(selectedBytes);
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

let relaySilent = false;
let fixtureEvent;
const relayEvents = new Map();
const relayErrors = [];
const relay = new WebSocketServer({ host: HOST, port: 0, maxPayload: 1024 * 1024 });
relay.on("connection", (socket) => {
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString("utf8"));
      if (message[0] === "EVENT") {
        const event = message[1];
        if (!verifyEvent(event) || event.pubkey !== PUBKEY) throw new Error("Mozilla Firefox relay received an invalid or unexpected signature.");
        relayEvents.set(event.id, event);
        socket.send(JSON.stringify(["OK", event.id, true, "stored by controlled Firefox relay"]));
      }
      if (message[0] === "REQ" && !relaySilent) {
        const subscription = message[1];
        const requestedId = message[2]?.ids?.[0];
        const event = relayEvents.get(requestedId);
        if (event) socket.send(JSON.stringify(["EVENT", subscription, event]));
        socket.send(JSON.stringify(["EOSE", subscription]));
      }
    } catch (error) {
      relayErrors.push(error instanceof Error ? error.message : String(error));
    }
  });
});
relay.on("error", (error) => relayErrors.push(error.message));

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

let production;
let record;
let downloaderRecord;
let blossomClosed = false;
try {
  const firefox = findFirefox();
  await Promise.all([listen(blossom), new Promise((resolve, reject) => {
    relay.once("listening", resolve);
    relay.once("error", reject);
  }), listen(secureTracker)]);
  const blossomAddress = blossom.address();
  const relayAddress = relay.address();
  const trackerAddress = secureTracker.address();
  if (!blossomAddress || typeof blossomAddress === "string") throw new Error("Controlled Blossom did not expose a port.");
  if (!relayAddress || typeof relayAddress === "string") throw new Error("Controlled relay did not expose a port.");
  if (!trackerAddress || typeof trackerAddress === "string") throw new Error("Controlled tracker did not expose a port.");
  const blossomOrigin = `http://${HOST}:${blossomAddress.port}`;
  const relayUrl = `ws://${HOST}:${relayAddress.port}`;
  const trackerUrl = `wss://${HOST}:${trackerAddress.port}/announce`;

  const fixture = await makeIndependentFixture(blossomOrigin);
  encryptedBytes = fixture.encrypted;
  encryptedHash = fixture.hash;
  fixtureEvent = fixture.event;
  relayEvents.set(fixtureEvent.id, fixtureEvent);

  const appPort = await availablePort();
  const appOrigin = `http://${HOST}:${appPort}`;
  production = spawn(process.execPath, ["scripts/serve-production.mjs", "--host", HOST, "--port", String(appPort)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(async () => {
    if (production.exitCode !== null) throw new Error(`Production server exited early with ${production.exitCode}.`);
    try {
      return (await fetch(`${appOrigin}/healthz`)).ok;
    } catch {
      return false;
    }
  }, ACTION_TIMEOUT_MS, "Production server did not start for Mozilla Firefox acceptance.");

  const allowedOrigins = new Set([appOrigin, blossomOrigin, new URL(relayUrl).origin, new URL(trackerUrl).origin]);
  record = await launchFirefox(firefox, appOrigin, allowedOrigins, "publisher");
  const initialExternalRequests = record.requests.filter((request) => {
    const url = new URL(request);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.origin !== appOrigin;
  });
  if (initialExternalRequests.length !== 0 || blossomRequests.length !== 0) {
    throw new Error(`Opening Wildbloom in Mozilla Firefox made ambient requests: ${initialExternalRequests.join("; ")}.`);
  }
  const initial = await evaluate(record, `(() => ({
    hasSigner: Boolean(window.nostr),
    torBoundary: document.querySelector("#tor-boundary")?.textContent ?? "",
    webRtcUsed: window.__wildbloomFirefoxWebRtcUsed,
  }))()`);
  if (initial.hasSigner || initial.webRtcUsed
    || !initial.torBoundary.includes("Use Tor Browser rather than SOCKS-proxying a normal browser")) {
    throw new Error(`Mozilla Firefox crossed an initial privacy boundary: ${JSON.stringify(initial)}.`);
  }

  await evaluate(record, `(() => {
    const input = document.querySelector("#publish-file");
    if (!(input instanceof HTMLInputElement)) throw new Error("Publication file input is missing.");
    const transfer = new DataTransfer();
    transfer.items.add(new File([new TextEncoder().encode("prepared in genuine Firefox")], "firefox-prepared.txt", {
      type: "text/plain",
      lastModified: 0,
    }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.files.length;
  })()`);
  await click(record, "#inspect-file");
  await waitForText(record, "#publish-status", /Encrypted transfer payload prepared/iu);
  const prepared = await evaluate(record, `(() => ({
    recoveryKey: document.querySelector("#recovery-key-output")?.value ?? "",
    uploadDisabled: document.querySelector("#upload-file")?.disabled,
  }))()`);
  if (!/^wbk1_[A-Za-z0-9_-]{43}$/u.test(prepared.recoveryKey) || prepared.uploadDisabled !== true
    || blossomRequests.length !== 0) {
    throw new Error(`Mozilla Firefox did not prepare an encrypted local-only file safely: ${JSON.stringify(prepared)}.`);
  }

  await setChecked(record, 'input[name="signing-method"][value="external"]', true);
  await setValue(record, "#external-signer-pubkey", PUBKEY);
  await setValue(record, "#blossom-server", blossomOrigin);
  await setValue(record, "#relay-urls", relayUrl);
  await setValue(record, "#tracker-urls", trackerUrl);
  await click(record, "#connect-signer");
  await waitForText(record, "#publish-status", /External signer public key confirmed/iu);
  await setChecked(record, "#upload-consent", true);
  await setChecked(record, "#key-saved-consent", true);
  const uploadsBeforeSignature = blossomRequests.filter((value) => value === "PUT /upload").length;
  await click(record, "#upload-file");
  await waitForUnsignedTemplate(record, 24242);
  if (blossomRequests.filter((value) => value === "PUT /upload").length !== uploadsBeforeSignature) {
    throw new Error("Mozilla Firefox uploaded before exact external authority was returned.");
  }
  await completeExternalSignature(record, 24242);
  await waitForText(record, "#publish-status", /hybrid metadata is staged/iu);
  if (uploadAuthorisations.length !== 1 || !publishedBytes || !publishedHash) {
    throw new Error("Mozilla Firefox did not complete the externally authorised encrypted upload.");
  }

  await click(record, "#sign-events");
  const publishedFileEvent = await completeExternalSignature(record, 1063);
  await completeExternalSignature(record, 2003);
  await waitForText(record, "#publish-status", /Exact external signatures accepted/iu);
  await setChecked(record, "#publish-consent", true);
  await click(record, "#publish-events");
  await waitForText(record, "#publish-status", /2\/2 acknowledgements/iu);
  if (!relayEvents.has(publishedFileEvent.id)) throw new Error("Mozilla Firefox publication did not reach the controlled relay.");

  await setValue(record, "#event-id", publishedFileEvent.id);
  await click(record, "#resolve-event");
  await waitForText(record, "#retrieve-status", /separately received recovery key/iu);
  await setValue(record, "#recovery-key-input", prepared.recoveryKey);
  await click(record, "#fetch-blossom");
  await waitForText(record, "#retrieve-status", /locally decrypted bytes/iu);
  const publishedRecovery = await evaluate(record, `(async () => {
    const link = document.querySelector("#retrieve-links a");
    if (!(link instanceof HTMLAnchorElement)) throw new Error("Published Firefox download link is missing.");
    const blob = window.__wildbloomObservedObjectUrls?.get(link.href);
    if (!(blob instanceof Blob)) throw new Error("Published Firefox download Blob was not observed.");
    return {
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      name: link.download,
      type: blob.type,
      rel: link.rel,
    };
  })()`);
  if (publishedRecovery.name !== "firefox-prepared.txt"
    || publishedRecovery.type !== "application/octet-stream"
    || !publishedRecovery.rel.includes("noopener")
    || !Buffer.from(publishedRecovery.bytes).equals(PREPARED_BYTES)) {
    throw new Error("Mozilla Firefox did not recover its own externally signed publication exactly.");
  }

  const publishedFacts = (await snapshot(record, "#file-facts"))?.text ?? "";
  const infoHash = /Info hash([0-9a-f]{40})/u.exec(publishedFacts)?.[1];
  if (!infoHash) throw new Error("Mozilla Firefox did not expose the reviewed torrent info hash.");
  await setChecked(record, "#seed-consent", true);
  await click(record, "#start-seeding");
  await waitForText(record, "#publish-status", new RegExp(`Seeding ${infoHash}`, "u"), PEER_TIMEOUT_MS);

  publishedRetrievalDenied = true;
  downloaderRecord = await launchFirefox(firefox, appOrigin, allowedOrigins, "downloader");
  const downloaderInitialExternalRequests = downloaderRecord.requests.filter((request) => {
    const url = new URL(request);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.origin !== appOrigin;
  });
  const downloaderInitial = await evaluate(downloaderRecord, `(() => ({
    errors: [...window.__wildbloomPageErrors],
    hasSigner: Boolean(window.nostr),
    webRtcUsed: window.__wildbloomFirefoxWebRtcUsed,
  }))()`);
  if (downloaderInitialExternalRequests.length > 0 || downloaderInitial.errors.length > 0
    || downloaderInitial.hasSigner || downloaderInitial.webRtcUsed) {
    throw new Error(`Fresh Mozilla Firefox downloader crossed its initial privacy boundary: ${JSON.stringify({
      downloaderInitial,
      requests: downloaderInitialExternalRequests,
    })}.`);
  }
  await setValue(downloaderRecord, "#blossom-server", blossomOrigin);
  await setValue(downloaderRecord, "#relay-urls", relayUrl);
  await setValue(downloaderRecord, "#tracker-urls", trackerUrl);
  await setValue(downloaderRecord, "#event-id", publishedFileEvent.id);
  await click(downloaderRecord, "#resolve-event");
  await waitForText(downloaderRecord, "#retrieve-status", /separately received recovery key/iu);
  await setValue(downloaderRecord, "#recovery-key-input", WRONG_RECOVERY_KEY);
  await setChecked(downloaderRecord, "#download-swarm-consent", true);
  await click(downloaderRecord, "#fetch-swarm");
  await waitForText(
    downloaderRecord,
    "#retrieve-status",
    /wrong or the encrypted envelope was modified/iu,
    PEER_TIMEOUT_MS,
  );
  await waitFor(
    () => peerCount(tracker, infoHash) === 1,
    ACTION_TIMEOUT_MS,
    "A failed recovery key left the genuine Firefox downloader in the swarm.",
  );
  const failedPeerRecovery = await evaluate(downloaderRecord, `(() => ({
    fetchDisabled: document.querySelector("#fetch-swarm")?.disabled,
    links: document.querySelectorAll("#retrieve-links a").length,
  }))()`);
  if (failedPeerRecovery.fetchDisabled !== false || failedPeerRecovery.links !== 0) {
    throw new Error(`Failed genuine Firefox peer decryption retained output or blocked retry: ${JSON.stringify(failedPeerRecovery)}.`);
  }

  await setValue(downloaderRecord, "#recovery-key-input", prepared.recoveryKey);
  await click(downloaderRecord, "#fetch-swarm");
  await waitForText(downloaderRecord, "#retrieve-status", /Swarm ciphertext/iu, PEER_TIMEOUT_MS);
  const peerRecovery = await evaluate(downloaderRecord, `(async () => {
    const link = document.querySelector("#retrieve-links a");
    if (!(link instanceof HTMLAnchorElement)) throw new Error("Peer-recovered Firefox download link is missing.");
    const blob = window.__wildbloomObservedObjectUrls?.get(link.href);
    if (!(blob instanceof Blob)) throw new Error("Peer-recovered Firefox Blob was not observed.");
    return {
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      name: link.download,
      type: blob.type,
      rel: link.rel,
    };
  })()`, PEER_TIMEOUT_MS);
  if (peerRecovery.name !== "firefox-prepared.txt"
    || peerRecovery.type !== "application/octet-stream"
    || !peerRecovery.rel.includes("noopener")
    || !Buffer.from(peerRecovery.bytes).equals(PREPARED_BYTES)) {
    throw new Error("Two genuine Mozilla Firefox processes did not recover the exact peer bytes.");
  }
  await waitFor(
    () => peerCount(tracker, infoHash) >= 2,
    ACTION_TIMEOUT_MS,
    "The controlled tracker never observed two live genuine Firefox peers.",
  );
  const starts = trackerEvents.filter((entry) => entry.event === "start" && entry.infoHash === infoHash);
  if (starts.length < 3) {
    throw new Error("The controlled WSS tracker did not receive the Firefox publisher, failed-key and retry start announcements.");
  }
  await Promise.all([assertPeerEvidence(record), assertPeerEvidence(downloaderRecord)]);
  assertAllowedRequests(record, allowedOrigins);
  assertAllowedRequests(downloaderRecord, allowedOrigins);
  const peerPageState = await Promise.all([record, downloaderRecord].map((browserRecord) => evaluate(browserRecord, `(() => ({
    errors: [...window.__wildbloomPageErrors],
    hasSigner: Boolean(window.nostr),
    webRtcUsed: window.__wildbloomFirefoxWebRtcUsed,
  }))()`)));
  if (peerPageState.some((state) => state.errors.length > 0 || state.hasSigner || !state.webRtcUsed)) {
    throw new Error(`Genuine Firefox peer pages crossed their page, signer or WebRTC boundary: ${JSON.stringify(peerPageState)}.`);
  }

  await setChecked(downloaderRecord, "#download-swarm-consent", false);
  await waitForText(downloaderRecord, "#retrieve-status", /Swarm participation stopped/iu);
  await waitFor(
    () => peerCount(tracker, infoHash) <= 1,
    ACTION_TIMEOUT_MS,
    "Withdrawing genuine Firefox swarm consent did not stop the downloading peer.",
  );
  const withdrawn = await evaluate(downloaderRecord, `(() => ({
    consent: document.querySelector("#download-swarm-consent")?.checked,
    fetchDisabled: document.querySelector("#fetch-swarm")?.disabled,
  }))()`);
  if (withdrawn.consent !== false || withdrawn.fetchDisabled !== true) {
    throw new Error(`Withdrawing genuine Firefox swarm consent retained authority: ${JSON.stringify(withdrawn)}.`);
  }

  await evaluate(record, `(() => {
    const input = document.querySelector("#publish-file");
    if (!(input instanceof HTMLInputElement)) throw new Error("Publication file input is missing.");
    const transfer = new DataTransfer();
    transfer.items.add(new File([new TextEncoder().encode("replacement")], "replacement.txt", {
      type: "text/plain",
      lastModified: 0,
    }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.files.length;
  })()`);
  await waitFor(
    () => peerCount(tracker, infoHash) === 0,
    ACTION_TIMEOUT_MS,
    "Changing the genuine Firefox source did not stop the publishing peer.",
  );
  const publisherWithdrawn = await evaluate(record, `(() => ({
    consent: document.querySelector("#seed-consent")?.checked,
    seedDisabled: document.querySelector("#start-seeding")?.disabled,
  }))()`);
  if (publisherWithdrawn.consent !== false || publisherWithdrawn.seedDisabled !== true) {
    throw new Error(`Changing the genuine Firefox source retained swarm authority: ${JSON.stringify(publisherWithdrawn)}.`);
  }
  await closeFirefox(downloaderRecord);
  downloaderRecord = undefined;
  if (peerCount(tracker, infoHash) !== 0) throw new Error("Closing the withdrawn Firefox downloader restored peer authority.");

  await setValue(record, "#event-id", fixtureEvent.id);
  relaySilent = true;
  try {
    await click(record, "#resolve-event");
    await waitForText(record, "#retrieve-status", /lookup timed out/iu);
    const timedOut = await evaluate(record, `(() => ({
      fetchDisabled: document.querySelector("#fetch-blossom")?.disabled,
      links: document.querySelectorAll("#retrieve-links a").length,
      resolveDisabled: document.querySelector("#resolve-event")?.disabled,
    }))()`);
    if (timedOut.fetchDisabled !== true || timedOut.links !== 0 || timedOut.resolveDisabled !== false) {
      throw new Error(`Mozilla Firefox retained stale retrieval authority after relay timeout: ${JSON.stringify(timedOut)}.`);
    }
  } finally {
    relaySilent = false;
  }

  await click(record, "#resolve-event");
  await waitForText(record, "#retrieve-status", /separately received recovery key/iu);
  await setValue(record, "#recovery-key-input", fixture.recoveryKey);
  const startedBefore = hangingStarted;
  const closedBefore = hangingClosed;
  blossomMode = "hanging";
  try {
    await click(record, "#fetch-blossom");
    await waitFor(() => hangingStarted > startedBefore, ACTION_TIMEOUT_MS, "Mozilla Firefox did not begin the partial Blossom response.");
    await click(record, "#cancel-download");
    await waitForText(record, "#retrieve-status", /retrieval cancelled/iu);
    await waitFor(() => hangingClosed > closedBefore, ACTION_TIMEOUT_MS, "Mozilla Firefox cancellation did not close the Blossom response.");
    const cancelled = await snapshot(record, "#retrieve-links");
    if (cancelled?.links !== 0 || !(await snapshot(record, "#cancel-download"))?.disabled) {
      throw new Error("Mozilla Firefox retained stale output or cancellation authority after aborting retrieval.");
    }
  } finally {
    blossomMode = "normal";
  }

  await setValue(record, "#recovery-key-input", fixture.recoveryKey);
  await click(record, "#fetch-blossom");
  await waitForText(record, "#retrieve-status", /locally decrypted bytes/iu);
  const recovered = await evaluate(record, `(async () => {
    const link = document.querySelector("#retrieve-links a");
    if (!(link instanceof HTMLAnchorElement)) throw new Error("Verified Firefox download link is missing.");
    const blob = window.__wildbloomObservedObjectUrls?.get(link.href);
    if (!(blob instanceof Blob)) throw new Error("Verified Firefox download Blob was not observed.");
    return {
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      name: link.download,
      type: blob.type,
      rel: link.rel,
    };
  })()`);
  if (recovered.name !== "branded-firefox.txt"
    || recovered.type !== "application/octet-stream"
    || !recovered.rel.includes("noopener")
    || !Buffer.from(recovered.bytes).equals(SOURCE_BYTES)) {
    throw new Error("Mozilla Firefox did not recover the exact source bytes.");
  }

  await closeServer(blossom);
  blossomClosed = true;
  await setValue(record, "#recovery-key-input", fixture.recoveryKey);
  await click(record, "#fetch-blossom");
  await waitForText(record, "#retrieve-status", /retrieval failed|network|fetch/iu);
  const deniedStatus = await snapshot(record, "#retrieve-status");
  const deniedLinks = await snapshot(record, "#retrieve-links");
  if (!deniedStatus?.error || deniedLinks?.links !== 0) {
    throw new Error(`Mozilla Firefox retained stale or non-error state after denied service: ${JSON.stringify({ deniedLinks, deniedStatus })}.`);
  }

  const finalState = await evaluate(record, `(() => ({
    errors: [...window.__wildbloomPageErrors],
    hasSigner: Boolean(window.nostr),
    webRtcUsed: window.__wildbloomFirefoxWebRtcUsed,
  }))()`);
  if (finalState.errors.length > 0 || finalState.hasSigner || !finalState.webRtcUsed) {
    throw new Error(`Mozilla Firefox crossed its page, signer or WebRTC boundary: ${JSON.stringify(finalState)}.`);
  }
  assertAllowedRequests(record, allowedOrigins);
  if (blossomErrors.length > 0 || relayErrors.length > 0 || trackerErrors.length > 0) {
    throw new Error(`Controlled service errors: ${[...blossomErrors, ...relayErrors, ...trackerErrors].join("; ")}`);
  }
  process.stdout.write(
    `${firefox.version} acceptance passed through two disposable profiles: trustworthy production origin, no ambient network or signer, exact external-signature encrypted upload and two-event relay publication, exact peer recovery through the controlled WSS tracker with host-only ICE and confirmed cleanup after failed decryption and consent withdrawal, recovery of an independent fixture through an inert save, relay timeout, download cancellation and denied-service failure (${webSeedAttempts} refused web-seed requests).\n`,
  );
} finally {
  await closeFirefox(downloaderRecord).catch(() => undefined);
  await closeFirefox(record).catch(() => undefined);
  if (!blossomClosed) await closeServer(blossom).catch(() => undefined);
  await new Promise((resolve) => relay.close(() => resolve())).catch(() => undefined);
  await new Promise((resolve) => tracker.close(resolve)).catch(() => undefined);
  await closeServer(secureTracker).catch(() => undefined);
  await stopChild(production);
  rmSync(tempRoot, { recursive: true, force: true });
}
