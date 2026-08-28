import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { platform } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { chromium, firefox, webkit } from "playwright-core";
import { WebSocketServer } from "ws";
import { assertNoBrowserPersistence, installBrowserPersistenceAudit } from "./browser-persistence.mjs";
import {
  CONTENT_SECURITY_POLICY,
  DENIED_PERMISSION_FEATURES,
  PERMISSIONS_POLICY,
} from "./http-security.mjs";
import {
  generateKnownAnswerEnvelope,
  generateMultiRecordKnownAnswerEnvelope,
} from "./encryption-vector.mjs";

const HOST = "127.0.0.1";
async function availablePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, HOST, resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a production acceptance port.");
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const PORT = await availablePort();
const ORIGIN = `http://${HOST}:${PORT}`;
const BYTES = Buffer.from("hello wildbloom", "utf8");
const SOURCE_HASH = createHash("sha256").update(BYTES).digest("hex");
const KNOWN_ANSWER = generateKnownAnswerEnvelope();
const MULTI_RECORD_KNOWN_ANSWER = generateMultiRecordKnownAnswerEnvelope();
const KNOWN_ANSWER_FIXTURES = [KNOWN_ANSWER, MULTI_RECORD_KNOWN_ANSWER];
const WRONG_RECOVERY_KEY = `wbk1_${Buffer.alloc(32, 99).toString("base64url")}`;
const HOSTILE_BYTES = Buffer.from("<!doctype html><script>window.opener.document.body.textContent='compromised'</script>", "utf8");
const HOSTILE_HASH = createHash("sha256").update(HOSTILE_BYTES).digest("hex");
const SECRET = new Uint8Array(32).fill(11);
const PUBKEY = getPublicKey(SECRET);
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes) {
  let result = "";
  let bits = 0;
  let accumulator = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32[(accumulator >>> bits) & 31];
    }
  }
  return result;
}

function onionHostname() {
  const publicKey = new Uint8Array(32).fill(29);
  const version = new Uint8Array([3]);
  const prefix = new TextEncoder().encode(".onion checksum");
  const input = new Uint8Array(prefix.length + publicKey.length + 1);
  input.set(prefix);
  input.set(publicKey, prefix.length);
  input.set(version, prefix.length + publicKey.length);
  const address = new Uint8Array(35);
  address.set(publicKey);
  address.set(sha3_256(input).subarray(0, 2), 32);
  address.set(version, 34);
  return `${base32(address)}.onion`;
}

const ONION_HOST = onionHostname();
const ONION_BLOSSOM = `http://${ONION_HOST}`;
const uploadAuthorisations = [];
const blossomErrors = [];
let blossomOrigin;
let uploadedBytes;
let uploadedHash;
let hangUpload = false;
let hangDownload = false;
let hangingUploadStarted;
let hangingUploadClosed;
let hangingDownloadStarted;
let hangingDownloadClosed;
let holdNextSignature = false;
let heldSignatureStarted;
let releaseHeldSignature;
let nip07PublicKeyCalls = 0;
let nip07SignatureCalls = 0;

const blossom = createServer((request, response) => {
  void (async () => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-SHA-256",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    };
    const url = new URL(request.url ?? "/", blossomOrigin ?? `http://${HOST}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method === "PUT" && url.pathname === "/upload") {
      if (hangUpload) {
        hangingUploadStarted?.();
        response.once("close", () => hangingUploadClosed?.());
        request.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 2 * 1024 * 1024) throw new Error("Controlled Blossom upload exceeded its acceptance cap.");
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      if (body.length === 0) throw new Error("Browser upload omitted its request body.");
      if (body.includes(BYTES)) throw new Error("Browser upload exposed plaintext source bytes.");
      const hash = createHash("sha256").update(body).digest("hex");
      if (request.headers["x-sha-256"] !== hash) throw new Error("Browser upload sent the wrong X-SHA-256.");
      if (request.headers["content-type"] !== "application/vnd.forgesworn.encrypted") throw new Error("Browser upload exposed the source MIME type.");
      const authorisation = request.headers.authorization;
      if (!authorisation?.startsWith("Nostr ")) throw new Error("Browser upload omitted Blossom authorisation.");
      uploadAuthorisations.push(JSON.parse(Buffer.from(authorisation.slice(6), "base64url").toString("utf8")));
      uploadedBytes = body;
      uploadedHash = hash;
      const descriptorOrigin = request.headers["x-wildbloom-test-origin"] === ONION_BLOSSOM ? ONION_BLOSSOM : blossomOrigin;
      response.writeHead(201, { ...cors, "Content-Type": "application/json" });
      response.end(JSON.stringify({
        url: `${descriptorOrigin}/${hash}.wbenc`,
        sha256: hash,
        size: body.length,
        type: "application/vnd.forgesworn.encrypted",
        uploaded: 1_700_000_000,
      }));
      return;
    }
    if (request.method === "GET" && uploadedBytes && url.pathname === `/${uploadedHash}.wbenc`) {
      if (hangDownload) {
        response.writeHead(200, {
          ...cors,
          "Content-Type": "application/vnd.forgesworn.encrypted",
          "Content-Length": String(uploadedBytes.length),
        });
        response.write(uploadedBytes.subarray(0, Math.min(1024, uploadedBytes.length)));
        hangingDownloadStarted?.();
        response.once("close", () => hangingDownloadClosed?.());
        return;
      }
      response.writeHead(200, {
        ...cors,
        "Content-Type": "application/vnd.forgesworn.encrypted",
        "Content-Length": String(uploadedBytes.length),
      });
      response.end(uploadedBytes);
      return;
    }
    const knownAnswerFixture = KNOWN_ANSWER_FIXTURES.find(
      (fixture) => url.pathname === `/${fixture.envelopeSha256}.wbenc`,
    );
    if (request.method === "GET" && knownAnswerFixture) {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "application/vnd.forgesworn.encrypted",
        "Content-Length": String(knownAnswerFixture.envelope.length),
      });
      response.end(knownAnswerFixture.envelope);
      return;
    }
    if (request.method === "GET" && url.pathname === `/${HOSTILE_HASH}.html`) {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "text/html",
        "Content-Length": String(HOSTILE_BYTES.length),
      });
      response.end(HOSTILE_BYTES);
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
blossom.listen(0, HOST);

const onionProxyErrors = [];
const onionProxyRequests = [];
const onionProxy = createServer((request, response) => {
  let target;
  try {
    target = new URL(request.url ?? "");
    if (target.origin !== ONION_BLOSSOM) {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Controlled proxy refused non-onion target");
      return;
    }
    onionProxyRequests.push(`${request.method} ${target.pathname}`);
    const blossomAddress = blossom.address();
    if (!blossomAddress || typeof blossomAddress === "string") throw new Error("Controlled Blossom server is not listening.");
    const headers = { ...request.headers, host: `${HOST}:${blossomAddress.port}`, "x-wildbloom-test-origin": ONION_BLOSSOM };
    const upstream = httpRequest({
      host: HOST,
      port: blossomAddress.port,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      onionProxyErrors.push(error.message);
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Controlled proxy failure");
    });
    request.pipe(upstream);
  } catch (error) {
    onionProxyErrors.push(error instanceof Error ? error.message : String(error));
    response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Controlled proxy refusal");
  }
});
onionProxy.listen(0, HOST);

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
  throw new Error("Browser smoke requires an installed Chrome, Chromium, Brave or Edge executable.");
}

function requestedBrowser() {
  const browserArgumentIndex = process.argv.indexOf("--browser");
  const inlineArgument = process.argv.find((argument) => argument.startsWith("--browser="));
  if (browserArgumentIndex >= 0 && !process.argv[browserArgumentIndex + 1]) throw new Error("--browser requires a value.");
  const argumentValue = browserArgumentIndex >= 0 ? process.argv[browserArgumentIndex + 1] : inlineArgument?.slice("--browser=".length);
  const value = argumentValue ?? process.env.WILDBLOOM_BROWSER ?? "system-chromium";
  if (!["system-chromium", "chromium", "firefox", "webkit"].includes(value)) {
    throw new Error(`Unsupported WILDBLOOM_BROWSER value: ${value}`);
  }
  return value;
}

async function launchBrowser(name, proxyServer) {
  const options = { headless: true, proxy: { server: proxyServer, bypass: HOST } };
  if (name === "system-chromium") {
    return chromium.launch({ ...options, executablePath: findChrome() });
  }
  const browserType = name === "chromium" ? chromium : name === "firefox" ? firefox : webkit;
  return browserType.launch(options);
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertAccessible(page, state) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  if (result.violations.length === 0) return;
  const summary = result.violations.map((violation) => {
    const targets = violation.nodes.slice(0, 3).map((node) => JSON.stringify(node.target)).join(", ");
    return `${violation.id} (${violation.impact ?? "unknown"}): ${targets}`;
  }).join("; ");
  throw new Error(`${state} has WCAG A/AA violations: ${summary}`);
}

async function assertKeyboardEntry(page, browserName) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  let reachedSigner = false;
  // macOS WebKit follows Safari's default Option-Tab traversal unless the
  // host has enabled full keyboard access. Playwright maps Alt to Option.
  const traversalKey = browserName === "webkit" ? "Alt+Tab" : "Tab";
  // The product page now has marketing and documentation links before the
  // publishing tool.  Keep the test bounded while traversing the whole public
  // page rather than assuming the signer is among the first few controls.
  for (let index = 0; index < 64; index += 1) {
    await page.keyboard.press(traversalKey);
    if (await page.evaluate(() => document.activeElement?.id === "connect-signer")) {
      reachedSigner = true;
      break;
    }
  }
  if (!reachedSigner) throw new Error("Keyboard traversal did not reach the signer action in document order.");
  const visibleFocus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
  });
  if (!visibleFocus) throw new Error("Keyboard focus on the signer action was not visibly indicated.");
}

async function assertAdaptivePresentation(page, browserName) {
  const originalViewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (horizontalOverflow) throw new Error("The production page overflowed horizontally at a 320 CSS-pixel viewport.");
    await assertAccessible(page, "320 CSS-pixel reflow");

    if (browserName === "system-chromium" || browserName === "chromium") {
      await page.emulateMedia({ forcedColors: "active" });
      if (!(await page.evaluate(() => matchMedia("(forced-colors: active)").matches))) {
        throw new Error("Chromium did not enter forced-colours mode.");
      }
      await page.focus("#connect-signer");
      const focusVisible = await page.evaluate(() => {
        const element = document.activeElement;
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
      });
      if (!focusVisible) throw new Error("Forced-colours mode removed the visible keyboard focus indicator.");
      await assertAccessible(page, "Forced-colours production page");
    }
  } finally {
    if (browserName === "system-chromium" || browserName === "chromium") {
      await page.emulateMedia({ forcedColors: "none" });
    }
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
}

async function assertPageSessionCleared(page, label, requireLifecycleMessage = true) {
  const state = await page.evaluate(() => ({
    values: Object.fromEntries([
      "blossom-server",
      "relay-urls",
      "tracker-urls",
      "external-signer-pubkey",
      "recovery-key-output",
      "external-unsigned-event",
      "external-signed-event",
      "event-id",
      "recovery-key-input",
    ].map((id) => [id, document.querySelector(`#${id}`)?.value ?? null])),
    consents: Object.fromEntries([
      "tor-consent",
      "upload-consent",
      "key-saved-consent",
      "seed-consent",
      "publish-consent",
      "download-swarm-consent",
    ].map((id) => [id, document.querySelector(`#${id}`)?.checked ?? null])),
    fileCount: document.querySelector("#publish-file")?.files?.length ?? null,
    recoveryPanelHidden: document.querySelector("#recovery-key-panel")?.hidden ?? null,
    recoveryFieldHidden: document.querySelector("#recovery-key-field")?.hidden ?? null,
    externalPanelHidden: document.querySelector("#external-signing-panel")?.hidden ?? null,
    signerStatus: document.querySelector("#signer-status")?.textContent ?? "",
    publishStatus: document.querySelector("#publish-status")?.textContent ?? "",
    publishLinks: document.querySelectorAll("#publish-links a, #recovery-links a, #external-signing-links a").length,
    retrieveLinks: document.querySelectorAll("#retrieve-links a").length,
    objectUrls: window.__wildbloomObservedObjectUrls?.size ?? null,
    disabled: Object.fromEntries([
      "upload-file",
      "start-seeding",
      "stop-seeding",
      "sign-events",
      "publish-events",
      "fetch-blossom",
      "fetch-swarm",
      "cancel-download",
    ].map((id) => [id, document.querySelector(`#${id}`)?.disabled ?? null])),
  }));
  const retainedValues = Object.entries(state.values).filter(([, value]) => value !== "");
  const retainedConsents = Object.entries(state.consents).filter(([, checked]) => checked !== false);
  const enabledAuthority = Object.entries(state.disabled).filter(([, disabled]) => disabled !== true);
  if (retainedValues.length > 0
    || retainedConsents.length > 0
    || enabledAuthority.length > 0
    || state.fileCount !== 0
    || state.recoveryPanelHidden !== true
    || state.recoveryFieldHidden !== true
    || state.externalPanelHidden !== true
    || !state.signerStatus.includes("not connected")
    || (requireLifecycleMessage && !state.publishStatus.includes("session cleared"))
    || state.publishLinks !== 0
    || state.retrieveLinks !== 0
    || state.objectUrls !== 0) {
    throw new Error(`${label} retained page-session authority: ${JSON.stringify(state)}`);
  }
}

async function waitForServer(server) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Production server exited early with ${server.exitCode}.`);
    try {
      const response = await fetch(`${ORIGIN}/healthz`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the production server.");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function makeKnownAnswerEvent(fixture, origin, createdAt) {
  return finalizeEvent({
    kind: 1063,
    created_at: createdAt,
    tags: [
      ["url", `${origin}/${fixture.envelopeSha256}.wbenc`],
      ["m", "application/vnd.forgesworn.encrypted"],
      ["x", fixture.envelopeSha256],
      ["ox", fixture.envelopeSha256],
      ["size", String(fixture.envelope.length)],
      ["encryption", "wildbloom-aes-256-gcm-chunked-v1"],
      ["alt", "Encrypted Wildbloom file"],
    ],
    content: "wildbloom.wbenc",
  }, SECRET);
}

const relayEvents = new Map();
const relay = new WebSocketServer({ host: HOST, port: 0, maxPayload: 1024 * 1024 });
relay.on("connection", (socket) => socket.on("message", (raw) => {
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
}));

const production = spawn(process.execPath, ["scripts/serve-production.mjs", "--host", HOST, "--port", String(PORT)], {
  stdio: ["ignore", "pipe", "pipe"],
});

let browser;
try {
  await Promise.all([waitForServer(production), listen(relay), listen(blossom), listen(onionProxy)]);
  const relayAddress = relay.address();
  if (!relayAddress || typeof relayAddress === "string") throw new Error("Controlled relay did not expose a TCP port.");
  const relayUrl = `ws://${HOST}:${relayAddress.port}`;
  const blossomAddress = blossom.address();
  if (!blossomAddress || typeof blossomAddress === "string") throw new Error("Controlled Blossom server did not expose a TCP port.");
  blossomOrigin = `http://${HOST}:${blossomAddress.port}`;
  const knownAnswerEvent = makeKnownAnswerEvent(KNOWN_ANSWER, blossomOrigin, 1_700_000_002);
  const multiRecordKnownAnswerEvent = makeKnownAnswerEvent(
    MULTI_RECORD_KNOWN_ANSWER,
    blossomOrigin,
    1_700_000_003,
  );
  relayEvents.set(knownAnswerEvent.id, knownAnswerEvent);
  relayEvents.set(multiRecordKnownAnswerEvent.id, multiRecordKnownAnswerEvent);
  const proxyAddress = onionProxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Controlled onion proxy did not expose a TCP port.");
  const proxyOrigin = `http://${HOST}:${proxyAddress.port}`;

  const headersResponse = await fetch(ORIGIN);
  const csp = headersResponse.headers.get("content-security-policy") ?? "";
  if (csp !== CONTENT_SECURITY_POLICY || headersResponse.headers.get("x-frame-options") !== "DENY") {
    throw new Error("Production response security headers are missing.");
  }
  const permissionsPolicy = headersResponse.headers.get("permissions-policy") ?? "";
  if (permissionsPolicy !== PERMISSIONS_POLICY) {
    throw new Error("Production response Permissions-Policy is missing.");
  }
  if ((await fetch(`${ORIGIN}/healthz`, { method: "POST" })).status !== 405) {
    throw new Error("Production server accepted a state-changing HTTP method.");
  }
  if ((await fetch(`${ORIGIN}/does-not-exist`)).status !== 404) {
    throw new Error("Production server did not return a genuine 404.");
  }

  const browserName = requestedBrowser();
  browser = await launchBrowser(browserName, proxyOrigin);
  const context = await within(browser.newContext(), 30_000, `${browserName} did not create a context within 30 seconds.`);
  const page = await within(context.newPage(), 30_000, `${browserName} did not create a page within 30 seconds.`);
  const pageErrors = [];
  const remoteRequests = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.exposeFunction("__wildbloomGetPublicKey", () => {
    nip07PublicKeyCalls += 1;
    return PUBKEY;
  });
  await page.exposeFunction("__wildbloomSignEvent", async (template) => {
    nip07SignatureCalls += 1;
    if (holdNextSignature) {
      holdNextSignature = false;
      heldSignatureStarted?.();
      await new Promise((resolve) => { releaseHeldSignature = resolve; });
    }
    return finalizeEvent(template, SECRET);
  });
  await page.addInitScript(() => {
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
    Object.defineProperty(window, "nostr", {
      configurable: false,
      value: {
        getPublicKey: () => window.__wildbloomGetPublicKey(),
        signEvent: (template) => window.__wildbloomSignEvent(template),
      },
    });
  });
  await page.addInitScript(installBrowserPersistenceAudit);

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === ORIGIN) {
      await route.continue();
      return;
    }
    remoteRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    if (url.origin === blossomOrigin) {
      await route.continue();
      return;
    }
    if (url.origin === ONION_BLOSSOM) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });

  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  if (remoteRequests.length !== 0) throw new Error(`Page made ambient remote requests: ${remoteRequests.join(", ")}`);
  const browserPolicy = await page.evaluate((deniedFeatures) => {
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    const supported = typeof policy?.features === "function" ? new Set(policy.features()) : new Set();
    const allowed = deniedFeatures.filter(
      (feature) => supported.has(feature) && policy.allowsFeature(feature),
    );
    let trustedTypesEnforced = null;
    let trustedTypesPoliciesBlocked = null;
    if (window.trustedTypes) {
      const probe = document.createElement("div");
      try {
        probe.innerHTML = "<span>blocked probe</span>";
        trustedTypesEnforced = false;
      } catch (error) {
        trustedTypesEnforced = error instanceof TypeError;
      }
      try {
        window.trustedTypes.createPolicy("wildbloom-acceptance-probe", { createHTML: (value) => value });
        trustedTypesPoliciesBlocked = false;
      } catch (error) {
        trustedTypesPoliciesBlocked = error instanceof TypeError;
      }
    }
    return { allowed, supportedCount: supported.size, trustedTypesEnforced, trustedTypesPoliciesBlocked };
  }, DENIED_PERMISSION_FEATURES);
  if (browserPolicy.allowed.length > 0) {
    throw new Error(`Browser allowed denied capabilities: ${browserPolicy.allowed.join(", ")}`);
  }
  if (browserPolicy.trustedTypesEnforced === false || browserPolicy.trustedTypesPoliciesBlocked === false) {
    throw new Error(`Browser did not enforce the Trusted Types boundary: ${JSON.stringify(browserPolicy)}`);
  }
  const protectedControls = [
    "blossom-server",
    "relay-urls",
    "tracker-urls",
    "external-signer-pubkey",
    "recovery-key-output",
    "external-unsigned-event",
    "external-signed-event",
    "event-id",
    "recovery-key-input",
  ];
  for (const id of protectedControls) {
    const attributes = await page.locator(`#${id}`).evaluate((element) => ({
      autocomplete: element.getAttribute("autocomplete"),
      autocapitalize: element.getAttribute("autocapitalize"),
      autocorrect: element.getAttribute("autocorrect"),
      spellcheck: element.getAttribute("spellcheck"),
      translate: element.getAttribute("translate"),
    }));
    if (JSON.stringify(attributes) !== JSON.stringify({
      autocomplete: "off",
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: "false",
      translate: "no",
    })) {
      throw new Error(`Protected control #${id} is missing browser-retention hints: ${JSON.stringify(attributes)}`);
    }
  }
  if (!(await page.locator("#upload-consent-copy").textContent())?.includes("encrypted bytes")) {
    throw new Error("The default encryption choice is not reflected in the upload authority copy.");
  }
  if (!(await page.locator("#tor-boundary").textContent())?.includes("Use Tor Browser rather than SOCKS-proxying a normal browser")) {
    throw new Error("Tor boundary did not reject an ordinary proxied browser as an anonymity substitute.");
  }
  await assertAccessible(page, "Initial production page");
  await assertKeyboardEntry(page, browserName);
  await assertAdaptivePresentation(page, browserName);

  await page.fill("#blossom-server", blossomOrigin);
  await page.fill("#relay-urls", relayUrl);
  await page.fill("#tracker-urls", "wss://tracker.example.com/announce");
  await page.click("#connect-signer");
  await page.evaluate(() => {
    const chunk = new Uint8Array(1024 * 1024);
    const file = new File(Array.from({ length: 32 }, () => chunk), "superseded.bin", {
      type: "application/octet-stream",
      lastModified: 0,
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector("#publish-file");
    if (!(input instanceof HTMLInputElement)) throw new Error("File input is missing.");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.click("#inspect-file");
  await page.locator("#publish-status").filter({ hasText: /Hashing the source|Encrypting and padding/u }).waitFor();
  await page.setInputFiles("#publish-file", { name: "hello.txt", mimeType: "text/plain", buffer: BYTES });
  await page.locator("#publish-status").filter({ hasText: "File selection changed" }).waitFor();
  await page.waitForTimeout(500);
  if (!(await page.isHidden("#recovery-key-panel"))
    || await page.locator("#file-facts").textContent() !== ""
    || await page.isEnabled("#upload-file")) {
    throw new Error("A superseded local encryption repopulated stale file or recovery state.");
  }
  await page.click("#inspect-file");
  await page.locator("#publish-status").filter({ hasText: "Encrypted transfer payload prepared" }).waitFor();
  const facts = await page.locator("#file-facts").textContent();
  if (!facts?.includes(SOURCE_HASH) || !facts.includes("wildbloom.wbenc") || facts.includes("Public payloadhello.txt")) {
    throw new Error("Browser did not separate private source facts from public encrypted metadata.");
  }
  const recoveryKey = await page.inputValue("#recovery-key-output");
  if (!/^wbk1_[A-Za-z0-9_-]{43}$/u.test(recoveryKey)) throw new Error("Browser did not generate a recovery key.");
  if (await page.getAttribute("#recovery-key-output", "type") !== "password") throw new Error("Recovery key was visible without a reveal action.");
  await page.focus("#toggle-recovery-key");
  await page.keyboard.press("Enter");
  if (await page.getAttribute("#recovery-key-output", "type") !== "text") throw new Error("Recovery-key reveal action failed.");
  await page.keyboard.press("Enter");
  await assertAccessible(page, "Prepared encrypted publication");

  await page.check("#upload-consent");
  if (await page.isEnabled("#upload-file")) throw new Error("Upload enabled before recovery-key acknowledgement.");
  await page.check("#key-saved-consent");
  const uploadStarted = new Promise((resolve) => { hangingUploadStarted = resolve; });
  const uploadClosed = new Promise((resolve) => { hangingUploadClosed = resolve; });
  hangUpload = true;
  await page.click("#upload-file");
  await within(uploadStarted, 5_000, "Controlled interrupted upload did not reach Blossom.");
  await page.focus("#cancel-upload");
  await page.keyboard.press("Enter");
  await page.locator("#publish-status").filter({ hasText: "Blossom upload cancelled" }).waitFor();
  await within(uploadClosed, 5_000, "Cancelling the upload did not close the Blossom request.");
  hangUpload = false;
  hangingUploadStarted = undefined;
  hangingUploadClosed = undefined;
  if (!(await page.isDisabled("#cancel-upload")) || !(await page.isEnabled("#upload-file"))) {
    throw new Error("Cancelled upload did not restore a safe retry state.");
  }
  await page.click("#upload-file");
  await page.locator("#publish-status").filter({ hasText: "hybrid metadata is staged" }).waitFor();
  const stagedFacts = await page.locator("#file-facts").textContent();
  if (!stagedFacts?.includes("magnet:?")) throw new Error("Browser did not stage torrent metadata.");
  if (uploadAuthorisations.length !== 1 || !uploadedHash) throw new Error("Browser did not send one signed Blossom upload.");
  const directAuth = uploadAuthorisations[0];
  const scopedTags = directAuth.tags.filter((tag) => ["t", "server", "x"].includes(tag[0]));
  if (JSON.stringify(scopedTags) !== JSON.stringify([["t", "upload"], ["server", HOST], ["x", uploadedHash]])) {
    throw new Error("Browser upload authorisation was not exactly scoped.");
  }
  const expiration = Number(directAuth.tags.find((tag) => tag[0] === "expiration")?.[1]);
  if (expiration - directAuth.created_at !== 90) throw new Error("Browser upload authorisation lifetime changed.");

  await page.click("#sign-events");
  await page.locator("#publish-status").filter({ hasText: "Signed locally through NIP-07" }).waitFor();
  const signedStatus = await page.locator("#publish-status").textContent();
  const eventId = /1063: ([0-9a-f]{64})/u.exec(signedStatus ?? "")?.[1];
  if (!eventId) throw new Error("Browser did not expose the signed NIP-94 event ID.");
  await page.check("#publish-consent");
  await page.click("#publish-events");
  await page.locator("#publish-status").filter({ hasText: "Relay publication finished" }).waitFor();
  const publicationStatus = await page.locator("#publish-status").textContent();
  if (!publicationStatus?.includes("2/2 acknowledgements")) throw new Error(`Controlled relay publication failed: ${publicationStatus}`);

  await page.fill("#event-id", eventId);
  await page.click("#resolve-event");
  await page.locator("#retrieve-status").filter({ hasText: "separately received recovery key" }).waitFor();
  await page.fill("#recovery-key-input", recoveryKey);
  await page.click("#fetch-blossom");
  await page.locator("#retrieve-status").filter({ hasText: "locally decrypted bytes" }).waitFor();
  const safeDownload = await page.getByRole("link", { name: "Save verified hello.txt" }).evaluate((anchor) => ({
    mimeType: window.__wildbloomObservedObjectUrls?.get(anchor.href)?.type,
    rel: anchor.rel,
  }));
  if (safeDownload.mimeType !== "application/octet-stream" || !safeDownload.rel.includes("noopener")) {
    throw new Error(`Verified remote bytes retained an executable object-URL context: ${JSON.stringify(safeDownload)}`);
  }
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Save verified hello.txt" }).click();
  const download = await downloadPromise;
  if (download.suggestedFilename() !== "hello.txt") throw new Error("Decrypted download exposed the wrong filename.");
  const downloadedPath = await download.path();
  if (!downloadedPath || !readFileSync(downloadedPath).equals(BYTES)) throw new Error("Browser recovery did not reproduce the source bytes.");
  await assertAccessible(page, "Verified recovery result");

  await page.fill("#recovery-key-input", recoveryKey);
  const downloadStarted = new Promise((resolve) => { hangingDownloadStarted = resolve; });
  const downloadClosed = new Promise((resolve) => { hangingDownloadClosed = resolve; });
  hangDownload = true;
  await page.click("#fetch-blossom");
  await within(downloadStarted, 5_000, "Controlled interrupted download did not reach Blossom.");
  await page.focus("#cancel-download");
  await page.keyboard.press("Enter");
  await page.locator("#retrieve-status").filter({ hasText: "Blossom retrieval cancelled" }).waitFor();
  await within(downloadClosed, 5_000, "Cancelling the download did not close the Blossom response.");
  hangDownload = false;
  hangingDownloadStarted = undefined;
  hangingDownloadClosed = undefined;
  if (!(await page.isDisabled("#cancel-download")) || await page.locator("#retrieve-links a").count() !== 0) {
    throw new Error("Cancelled retrieval retained a stale save link or active cancel authority.");
  }

  await page.fill("#event-id", knownAnswerEvent.id);
  await page.click("#resolve-event");
  await page.locator("#retrieve-status").filter({ hasText: "separately received recovery key" }).waitFor();
  await page.fill("#recovery-key-input", WRONG_RECOVERY_KEY);
  await page.click("#fetch-blossom");
  await page.locator("#retrieve-status.error")
    .filter({ hasText: /wrong or the encrypted envelope was modified/iu })
    .waitFor();
  if (await page.locator("#retrieve-links a").count() !== 0 || !(await page.isDisabled("#cancel-download"))) {
    throw new Error("Known-answer wrong-key rejection retained a save link or active download authority.");
  }
  await page.fill("#recovery-key-input", KNOWN_ANSWER.recoveryKey);
  await page.click("#fetch-blossom");
  await page.locator("#retrieve-status").filter({ hasText: "locally decrypted bytes" }).waitFor();
  const knownAnswerDownload = await page.getByRole("link", {
    name: `Save verified ${KNOWN_ANSWER.sourceName}`,
  }).evaluate(async (anchor) => {
    const blob = window.__wildbloomObservedObjectUrls?.get(anchor.href);
    return {
      bytes: blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : [],
      mimeType: blob?.type,
      rel: anchor.rel,
    };
  });
  if (knownAnswerDownload.mimeType !== "application/octet-stream"
    || !knownAnswerDownload.rel.includes("noopener")
    || !Buffer.from(knownAnswerDownload.bytes).equals(KNOWN_ANSWER.source)) {
    throw new Error(`Browser did not recover the exact published known-answer vector: ${JSON.stringify({
      bytes: knownAnswerDownload.bytes.length,
      mimeType: knownAnswerDownload.mimeType,
      rel: knownAnswerDownload.rel,
    })}`);
  }

  await page.fill("#event-id", multiRecordKnownAnswerEvent.id);
  await page.click("#resolve-event");
  await page.locator("#retrieve-status").filter({ hasText: "separately received recovery key" }).waitFor();
  await page.fill("#recovery-key-input", MULTI_RECORD_KNOWN_ANSWER.recoveryKey);
  await page.click("#fetch-blossom");
  await page.locator("#retrieve-status").filter({ hasText: "locally decrypted bytes" }).waitFor();
  const multiRecordDownload = await page.getByRole("link", {
    name: `Save verified ${MULTI_RECORD_KNOWN_ANSWER.sourceName}`,
  }).evaluate(async (anchor) => {
    const blob = window.__wildbloomObservedObjectUrls?.get(anchor.href);
    if (!blob) return { bytes: 0, mimeType: undefined, rel: anchor.rel, sha256: undefined };
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    return {
      bytes: blob.size,
      mimeType: blob.type,
      rel: anchor.rel,
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  });
  if (multiRecordDownload.bytes !== MULTI_RECORD_KNOWN_ANSWER.source.length
    || multiRecordDownload.mimeType !== "application/octet-stream"
    || !multiRecordDownload.rel.includes("noopener")
    || multiRecordDownload.sha256 !== MULTI_RECORD_KNOWN_ANSWER.sourceSha256) {
    throw new Error(`Browser did not recover the exact published two-record vector: ${JSON.stringify(
      multiRecordDownload,
    )}`);
  }

  const hostileEvent = finalizeEvent({
    kind: 1063,
    created_at: 1_700_000_001,
    tags: [
      ["url", `${blossomOrigin}/${HOSTILE_HASH}.html`],
      ["m", "text/html"],
      ["x", HOSTILE_HASH],
      ["ox", HOSTILE_HASH],
      ["size", String(HOSTILE_BYTES.length)],
      ["alt", "Untrusted signed HTML fixture"],
    ],
    content: "signed-hostile.html",
  }, SECRET);
  relayEvents.set(hostileEvent.id, hostileEvent);
  await page.fill("#event-id", hostileEvent.id);
  await page.click("#resolve-event");
  await page.locator("#retrieve-status").filter({ hasText: "advertised payload is plaintext" }).waitFor();
  await page.click("#fetch-blossom");
  await page.locator("#retrieve-status").filter({ hasText: "Blossom download verified" }).waitFor();
  const hostileDownload = await page.getByRole("link", { name: "Save verified signed-hostile.html" }).evaluate(async (anchor) => {
    const blob = window.__wildbloomObservedObjectUrls?.get(anchor.href);
    return { mimeType: blob?.type, rel: anchor.rel, text: await blob?.text() };
  });
  if (hostileDownload.mimeType !== "application/octet-stream"
    || !hostileDownload.rel.includes("noopener")
    || hostileDownload.text !== "<!doctype html><script>window.opener.document.body.textContent='compromised'</script>") {
    throw new Error(`Validly signed hostile HTML was not preserved inside an inert save: ${JSON.stringify(hostileDownload)}`);
  }

  const signatureHeld = new Promise((resolve) => { heldSignatureStarted = resolve; });
  holdNextSignature = true;
  await page.click("#sign-events");
  await within(signatureHeld, 5_000, "Controlled signer did not hold the cross-profile signing request.");
  await page.check('input[name="network-profile"][value="tor"]');
  releaseHeldSignature?.();
  releaseHeldSignature = undefined;
  heldSignatureStarted = undefined;
  await page.waitForTimeout(100);
  if (!(await page.isDisabled("#publish-events"))
    || !(await page.locator("#signer-status").textContent())?.includes("not connected")) {
    throw new Error("A superseded direct-mode signature or signer identity survived the switch to Tor-only mode.");
  }
  const trackerHidden = await page.isHidden("#tracker-field");
  const seedHidden = await page.isHidden("#seed-gate");
  const iceBoundaryHidden = await page.isHidden("#ice-boundary");
  if (!trackerHidden || !seedHidden || !iceBoundaryHidden) throw new Error(`Tor-only mode did not remove tracker and WebRTC controls (${trackerHidden}/${seedHidden}/${iceBoundaryHidden}, profile=${await page.locator('input[name="network-profile"]:checked').getAttribute("value")}).`);
  await assertAccessible(page, "Tor-only profile");
  await page.fill("#blossom-server", ONION_BLOSSOM);
  await page.click("#connect-signer");
  await page.locator("#publish-status").filter({ hasText: "Confirm that the entire browser is configured through Tor" }).waitFor();
  if (uploadAuthorisations.length !== 1 || !(await page.locator("#signer-status").textContent())?.includes("not connected")) {
    throw new Error("Tor-only mode retained identity or used the network before Tor confirmation.");
  }

  await page.check("#tor-consent");
  await page.click("#connect-signer");
  if ((await page.locator("#signer-status").textContent()) !== PUBKEY) throw new Error("Tor-only signer did not require a fresh connection.");
  await page.fill("#blossom-server", blossomOrigin);
  await page.check("#key-saved-consent");
  await page.check("#upload-consent");
  await page.click("#upload-file");
  await page.locator("#publish-status").filter({ hasText: "Tor-only mode" }).waitFor();
  if (uploadAuthorisations.length !== 1) throw new Error("Tor-only mode attempted a clearnet upload.");

  await page.fill("#blossom-server", ONION_BLOSSOM);
  await page.check("#key-saved-consent");
  await page.check("#upload-consent");
  await page.click("#upload-file");
  await page.locator("#publish-status").filter({ hasText: "No clearnet fallback" }).waitFor();
  const torAuth = uploadAuthorisations[1];
  if (!torAuth?.tags.some((tag) => tag[0] === "server" && tag[1] === ONION_HOST)) {
    throw new Error("Tor-only upload authority was not scoped to the exact onion service.");
  }
  if ((await page.locator("#file-facts").textContent())?.includes("Info hash")) {
    throw new Error("Tor-only mode created torrent metadata.");
  }
  await page.click("#sign-events");
  await page.locator("#publish-status").filter({ hasText: "Signed locally through NIP-07" }).waitFor();
  const torSigned = await page.locator("#publish-status").textContent();
  if ((torSigned?.match(/[0-9]+: [0-9a-f]{64}/gu) ?? []).length !== 1) throw new Error("Tor-only mode signed more than one event.");
  await page.uncheck("#tor-consent");
  await page.locator("#publish-status").filter({ hasText: "Tor confirmation withdrawn" }).waitFor();
  if (!(await page.isDisabled("#upload-file"))
    || !(await page.isDisabled("#publish-events"))
    || !(await page.locator("#signer-status").textContent())?.includes("not connected")) {
    throw new Error("Withdrawing Tor confirmation retained signer identity or network authority.");
  }

  await page.setInputFiles("#publish-file", { name: "replacement.txt", mimeType: "text/plain", buffer: Buffer.from("replacement") });
  for (const selector of ["#upload-consent", "#key-saved-consent", "#seed-consent", "#publish-consent"]) {
    if (await page.isChecked(selector)) throw new Error(`File change retained stale consent: ${selector}`);
  }
  if (await page.isEnabled("#upload-file")) throw new Error("File change retained a network-capable prepared state.");
  await page.uncheck("#protect-file");
  await page.click("#inspect-file");
  await page.locator("#publish-status").filter({ hasText: "Plaintext inspection complete" }).waitFor();
  if (!(await page.locator("#upload-consent-copy").textContent())?.includes("plaintext file")) {
    throw new Error("Plaintext opt-out did not surface its public-content warning.");
  }
  if (!(await page.isHidden("#recovery-key-panel"))) throw new Error("Plaintext opt-out displayed a misleading recovery key.");
  await assertAccessible(page, "Plaintext opt-out state");

  const nip07CallsBeforeExternal = { publicKey: nip07PublicKeyCalls, signatures: nip07SignatureCalls };
  await page.check('input[name="network-profile"][value="direct"]');
  await page.check('input[name="signing-method"][value="external"]');
  await page.check("#protect-file");
  await page.click("#inspect-file");
  await page.locator("#publish-status").filter({ hasText: "Encrypted transfer payload prepared" }).waitFor();
  await page.fill("#external-signer-pubkey", PUBKEY);
  await page.fill("#blossom-server", blossomOrigin);
  await page.fill("#relay-urls", relayUrl);
  await page.fill("#tracker-urls", "wss://tracker.example.com/announce");
  await page.click("#connect-signer");
  await page.check("#upload-consent");
  await page.check("#key-saved-consent");
  const authorisationsBeforeExternal = uploadAuthorisations.length;
  await page.click("#upload-file");
  await page.locator("#external-signing-panel").waitFor({ state: "visible" });
  await page.click("#cancel-external-signature");
  await page.locator("#external-signing-panel").waitFor({ state: "hidden" });
  await page.locator("#upload-file:enabled").waitFor();
  if (uploadAuthorisations.length !== authorisationsBeforeExternal) {
    throw new Error("Cancelling external upload signing reached Blossom.");
  }
  await page.click("#upload-file");
  await page.locator("#external-signing-panel").waitFor({ state: "visible" });
  await assertAccessible(page, "External upload-authorisation handoff");
  const uploadTemplate = JSON.parse(await page.inputValue("#external-unsigned-event"));
  if (uploadTemplate.kind !== 24242) throw new Error("External handoff did not expose the Blossom upload template first.");
  const handoffDownload = await page.locator("#external-signing-links a").evaluate((anchor) => ({
    mimeType: window.__wildbloomObservedObjectUrls?.get(anchor.href)?.type,
    download: anchor.download,
  }));
  if (handoffDownload.mimeType !== "application/octet-stream" || handoffDownload.download !== "wildbloom-unsigned-24242.json") {
    throw new Error(`External unsigned-event download was not inert and explicit: ${JSON.stringify(handoffDownload)}`);
  }
  const changedUploadTemplate = {
    ...uploadTemplate,
    tags: uploadTemplate.tags.map((tag) => tag[0] === "x" ? ["x", "00".repeat(32)] : tag),
  };
  await page.fill("#external-signed-event", JSON.stringify(finalizeEvent(changedUploadTemplate, SECRET)));
  await page.click("#accept-external-signature");
  await page.locator("#publish-status.error").filter({ hasText: "changed the event" }).waitFor();
  if (uploadAuthorisations.length !== authorisationsBeforeExternal || await page.isHidden("#external-signing-panel")) {
    throw new Error("A changed external upload signature reached the network or destroyed the retry ceremony.");
  }
  await page.fill("#external-signed-event", JSON.stringify(finalizeEvent(uploadTemplate, SECRET)));
  await page.click("#accept-external-signature");
  await page.locator("#publish-status").filter({ hasText: "hybrid metadata is staged" }).waitFor();
  const externalAuthorisation = uploadAuthorisations[authorisationsBeforeExternal];
  const externalExpiration = Number(externalAuthorisation?.tags.find((tag) => tag[0] === "expiration")?.[1]);
  if (!externalAuthorisation || externalExpiration - externalAuthorisation.created_at !== 300) {
    throw new Error("External Blossom authority was not bounded to the deliberate five-minute handoff window.");
  }

  await page.click("#sign-events");
  await page.waitForFunction(() => {
    const value = document.querySelector("#external-unsigned-event")?.value;
    return value ? JSON.parse(value).kind === 1063 : false;
  });
  const externalFileTemplate = JSON.parse(await page.inputValue("#external-unsigned-event"));
  await page.fill("#external-signed-event", JSON.stringify(finalizeEvent(externalFileTemplate, SECRET)));
  await page.click("#accept-external-signature");
  await page.waitForFunction(() => {
    const value = document.querySelector("#external-unsigned-event")?.value;
    return value ? JSON.parse(value).kind === 2003 : false;
  });
  const externalTorrentTemplate = JSON.parse(await page.inputValue("#external-unsigned-event"));
  await page.fill("#external-signed-event", JSON.stringify(finalizeEvent(externalTorrentTemplate, SECRET)));
  await page.click("#accept-external-signature");
  await page.locator("#publish-status").filter({ hasText: "Exact external signatures accepted" }).waitFor();
  await page.check("#publish-consent");
  await page.click("#publish-events");
  await page.locator("#publish-status").filter({ hasText: "2/2 acknowledgements" }).waitFor();
  if (nip07PublicKeyCalls !== nip07CallsBeforeExternal.publicKey || nip07SignatureCalls !== nip07CallsBeforeExternal.signatures) {
    throw new Error("External signer mode invoked the injected NIP-07 signer.");
  }
  await page.check('input[name="network-profile"][value="tor"]');
  if ((await page.inputValue("#external-signer-pubkey")) !== ""
    || !(await page.locator("#signer-status").textContent())?.includes("not connected")
    || !(await page.isDisabled("#publish-events"))
    || !(await page.isHidden("#external-signing-panel"))) {
    throw new Error("A profile change retained external signer identity or publication authority.");
  }

  const lifecycleRecoveryKey = await page.inputValue("#recovery-key-output");
  if (!/^wbk1_[A-Za-z0-9_-]{43}$/u.test(lifecycleRecoveryKey)) {
    throw new Error("Lifecycle acceptance did not begin with a live recovery key.");
  }
  await page.evaluate((recoveryKey) => {
    document.querySelector("#recovery-key-input").value = recoveryKey;
    document.querySelector("#external-signer-pubkey").value = "ab".repeat(32);
    document.querySelector("#external-unsigned-event").value = "sensitive unsigned event";
    document.querySelector("#external-signed-event").value = "sensitive signed event";
    document.querySelector("#event-id").value = "cd".repeat(32);
    for (const id of ["tor-consent", "upload-consent", "key-saved-consent", "seed-consent", "publish-consent", "download-swarm-consent"]) {
      document.querySelector(`#${id}`).checked = true;
    }
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  }, lifecycleRecoveryKey);
  await assertPageSessionCleared(page, `${browserName} pagehide`);
  await page.goto(`${ORIGIN}/healthz`);
  await page.goBack({ waitUntil: "networkidle" });
  await page.locator("#publish-status").waitFor();
  await assertPageSessionCleared(page, `${browserName} navigation return`, false);

  if (pageErrors.length > 0) throw new Error(`Browser page errors: ${pageErrors.join("; ")}`);
  if (blossomErrors.length > 0) throw new Error(`Controlled Blossom errors: ${blossomErrors.join("; ")}`);
  if (onionProxyErrors.length > 0) throw new Error(`Controlled onion proxy errors: ${onionProxyErrors.join("; ")}`);
  if (!onionProxyRequests.includes("PUT /upload")) throw new Error("Tor-only upload did not traverse the controlled onion proxy.");
  await assertNoBrowserPersistence(page, context, `${browserName} production journey`);

  const adaptiveEvidence = browserName === "system-chromium" || browserName === "chromium"
    ? "320px reflow and forced-colours"
    : "320px reflow";
  process.stdout.write(`Browser acceptance passed in ${browserName}: exact fail-closed response policy, supported browser capabilities denied, Trusted Types enforced when implemented, no ambient network or retained browser state, protected input hints, pagehide and navigation-return session clearing, WCAG A/AA scan, keyboard focus/actions, ${adaptiveEvidence}, encrypted upload/recovery, published one- and two-record known-answer recovery with wrong-key rejection and validly signed hostile HTML held inside inert verified saves, NIP-07 plus exact extension-free signing handoff, controlled relay round-trip, upload/download cancellation with closed connections, superseded local/signing state, consent reset and fail-closed Tor-only transport verified.\n`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => relay.close(resolve));
  await new Promise((resolve) => blossom.close(resolve));
  await new Promise((resolve) => onionProxy.close(resolve));
  production.kill("SIGTERM");
}
