import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent } from "nostr-tools/pure";
import { WebSocketServer } from "ws";
import { WebDriverBiDi } from "./webdriver-bidi.mjs";

const HOST = "127.0.0.1";
const ACTION_TIMEOUT_MS = 30_000;
const SOURCE_BYTES = Buffer.from("genuine Firefox exact recovery", "utf8");
const SECRET = new Uint8Array(32).fill(23);
const tempRoot = mkdtempSync(join(tmpdir(), "wildbloom-firefox-"));

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

async function launchFirefox(firefox, appOrigin, allowedOrigins) {
  const profileDirectory = join(tempRoot, "profile");
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

  const created = await bidi.command("session.new", { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
  const expectedEngine = /Firefox ([0-9.]+)/u.exec(firefox.version)?.[1];
  if (!expectedEngine || created.capabilities?.browserVersion !== expectedEngine) {
    throw new Error(`Firefox capability version ${created.capabilities?.browserVersion ?? "missing"} did not match ${firefox.version}.`);
  }
  await bidi.command("session.subscribe", { events: ["network.beforeRequestSent"] });
  await bidi.command("script.addPreloadScript", {
    functionDeclaration: `() => {
      window.__wildbloomFirefoxWebRtcUsed = false;
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
          constructor(...arguments_) {
            super(...arguments_);
            window.__wildbloomFirefoxWebRtcUsed = true;
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
    label: firefox.version,
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

let blossomMode = "normal";
let hangingStarted = 0;
let hangingClosed = 0;
let encryptedBytes;
let encryptedHash;
const blossomErrors = [];
const blossomRequests = [];
const blossom = createServer((request, response) => {
  void (async () => {
    const cors = { "Access-Control-Allow-Origin": "*" };
    const url = new URL(request.url ?? "/", "http://localhost");
    blossomRequests.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET" && encryptedBytes && url.pathname === `/${encryptedHash}.wbenc`) {
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
          "Content-Length": String(encryptedBytes.length),
          "Content-Type": "application/vnd.wildbloom.encrypted",
        });
        response.write(encryptedBytes.subarray(0, 1024));
        return;
      }
      response.writeHead(200, {
        ...cors,
        "Content-Length": String(encryptedBytes.length),
        "Content-Type": "application/vnd.wildbloom.encrypted",
      });
      response.end(encryptedBytes);
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
const relayErrors = [];
const relay = new WebSocketServer({ host: HOST, port: 0, maxPayload: 1024 * 1024 });
relay.on("connection", (socket) => {
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString("utf8"));
      if (message[0] !== "REQ" || relaySilent) return;
      const subscription = message[1];
      const requestedId = message[2]?.ids?.[0];
      if (fixtureEvent && requestedId === fixtureEvent.id) socket.send(JSON.stringify(["EVENT", subscription, fixtureEvent]));
      socket.send(JSON.stringify(["EOSE", subscription]));
    } catch (error) {
      relayErrors.push(error instanceof Error ? error.message : String(error));
    }
  });
});
relay.on("error", (error) => relayErrors.push(error.message));

let production;
let record;
let blossomClosed = false;
try {
  const firefox = findFirefox();
  await Promise.all([listen(blossom), new Promise((resolve, reject) => {
    relay.once("listening", resolve);
    relay.once("error", reject);
  })]);
  const blossomAddress = blossom.address();
  const relayAddress = relay.address();
  if (!blossomAddress || typeof blossomAddress === "string") throw new Error("Controlled Blossom did not expose a port.");
  if (!relayAddress || typeof relayAddress === "string") throw new Error("Controlled relay did not expose a port.");
  const blossomOrigin = `http://${HOST}:${blossomAddress.port}`;
  const relayUrl = `ws://${HOST}:${relayAddress.port}`;

  const fixture = await makeIndependentFixture(blossomOrigin);
  encryptedBytes = fixture.encrypted;
  encryptedHash = fixture.hash;
  fixtureEvent = fixture.event;

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

  const allowedOrigins = new Set([appOrigin, blossomOrigin, new URL(relayUrl).origin]);
  record = await launchFirefox(firefox, appOrigin, allowedOrigins);
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

  await setValue(record, "#blossom-server", blossomOrigin);
  await setValue(record, "#relay-urls", relayUrl);
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
  if (finalState.errors.length > 0 || finalState.hasSigner || finalState.webRtcUsed) {
    throw new Error(`Mozilla Firefox crossed its page, signer or WebRTC boundary: ${JSON.stringify(finalState)}.`);
  }
  for (const request of record.requests) {
    const url = new URL(request);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !requestAllowed(request, allowedOrigins)) {
      throw new Error(`Mozilla Firefox made an undeclared application request to ${request}.`);
    }
  }
  if (blossomErrors.length > 0 || relayErrors.length > 0) {
    throw new Error(`Controlled service errors: ${[...blossomErrors, ...relayErrors].join("; ")}`);
  }
  process.stdout.write(
    `${firefox.version} acceptance passed through a disposable profile: trustworthy production origin, no ambient network or signer, local encrypted preparation, exact signer-free recovery through an inert save, relay timeout, download cancellation, denied-service failure and no WebRTC.\n`,
  );
} finally {
  await closeFirefox(record).catch(() => undefined);
  if (!blossomClosed) await closeServer(blossom).catch(() => undefined);
  await new Promise((resolve) => relay.close(() => resolve())).catch(() => undefined);
  await stopChild(production);
  rmSync(tempRoot, { recursive: true, force: true });
}
