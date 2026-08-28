import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import { WebDriverBiDi } from "./webdriver-bidi.mjs";

const HOST = "127.0.0.1";
const ONION_ACTION_TIMEOUT_MS = 3 * 60 * 1000;
const TOR_BOOTSTRAP_TIMEOUT_MS = 5 * 60 * 1000;
const SOURCE_BYTES = Buffer.from("real onion transport proof", "utf8");
const SECRET = new Uint8Array(32).fill(19);
const PUBKEY = getPublicKey(SECRET);
const tempRoot = mkdtempSync(join(tmpdir(), "wildbloom-tor-"));
const torData = join(tempRoot, "data");
const appService = join(tempRoot, "app-onion");
const blossomService = join(tempRoot, "blossom-onion");
const relayService = join(tempRoot, "relay-onion");
mkdirSync(torData, { mode: 0o700 });

function executable(candidates, description) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit path.
    }
  }
  throw new Error(`${description} was not found.`);
}

function findTor() {
  return executable([
    process.env.WILDBLOOM_TOR_PATH,
    "/opt/homebrew/bin/tor",
    "/usr/local/bin/tor",
    "/usr/bin/tor",
    "/Applications/Tor Browser.app/Contents/MacOS/Tor/tor",
  ], "Tor executable");
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
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return executable(candidates, "Chrome or Chromium executable");
}

function findTorBrowser() {
  const operatingSystem = platform();
  const candidates = operatingSystem === "darwin"
    ? [process.env.WILDBLOOM_TOR_BROWSER_PATH, "/Applications/Tor Browser.app/Contents/MacOS/firefox"]
    : operatingSystem === "linux"
      ? [
          process.env.WILDBLOOM_TOR_BROWSER_PATH,
          join(process.cwd(), ".artifacts", "tor-browser", "Browser", "firefox"),
        ]
      : [];
  const binary = executable(candidates, "Branded Tor Browser executable");
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const output = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim();
  if (version.status !== 0 || !/Tor Project Firefox [0-9]/u.test(output)) {
    throw new Error(`The selected executable did not identify as a branded Tor Browser build: ${output || "no version output"}`);
  }
  return { binary, version: output };
}

function brandedTorBrowserRequested() {
  return process.argv.includes("--branded-tor-browser");
}

function brandedRequestAllowed(request, allowedOrigins) {
  const actual = new URL(request);
  return [...allowedOrigins].some((origin) => {
    const allowed = new URL(origin);
    if (actual.hostname !== allowed.hostname || actual.port !== allowed.port) return false;
    if (actual.protocol === allowed.protocol) return true;
    return (actual.protocol === "http:" && allowed.protocol === "ws:")
      || (actual.protocol === "https:" && allowed.protocol === "wss:");
  });
}

function requestedBrowser() {
  const index = process.argv.indexOf("--browser");
  const inline = process.argv.find((argument) => argument.startsWith("--browser="));
  if (index >= 0 && !process.argv[index + 1]) throw new Error("--browser requires a value.");
  const value = index >= 0 ? process.argv[index + 1] : inline?.slice("--browser=".length) ?? "system-chromium";
  if (value !== "system-chromium") throw new Error(`Unsupported Tor acceptance browser: ${value}`);
  return value;
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

async function availablePort() {
  const reservation = createHttpServer();
  await listen(reservation);
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port.");
  await closeServer(reservation);
  return address.port;
}

async function waitFor(predicate, milliseconds, message, intervalMs = 100) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(typeof message === "function" ? message() : message);
}

function onionHostname(directory) {
  try {
    const value = readFileSync(join(directory, "hostname"), "utf8").trim();
    return /^[a-z2-7]{56}\.onion$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function controlTranscript(port, cookiePath, commands) {
  const cookie = readFileSync(cookiePath).toString("hex").toUpperCase();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: HOST, port });
    let output = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for the Tor control port."));
    }, 10_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`AUTHENTICATE ${cookie}\r\n${commands.join("\r\n")}\r\nQUIT\r\n`));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

async function signalNewIdentity(port, cookiePath) {
  const transcript = await controlTranscript(port, cookiePath, ["SIGNAL NEWNYM"]);
  if ((transcript.match(/250 OK/gu) ?? []).length < 2) throw new Error("Tor did not acknowledge authentication and NEWNYM.");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

let blossomOnionOrigin;
let uploadedBytes;
let uploadedHash;
let blossomRetrievalMode = "normal";
let hangingRetrievalStarted = 0;
let hangingRetrievalClosed = 0;
const blossomErrors = [];
const blossomHosts = [];
const blossomRequests = [];
const blossomAuthorisations = [];
const blossom = createHttpServer((request, response) => {
  void (async () => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Cache-Control, Content-Type, Range, X-SHA-256",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    };
    blossomHosts.push(request.headers.host ?? "");
    const url = new URL(request.url ?? "/", blossomOnionOrigin ?? "http://placeholder.onion");
    blossomRequests.push(`${request.method ?? "UNKNOWN"} ${url.pathname}`);
    if (blossomRequests.length > 100) blossomRequests.shift();
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method === "PUT" && url.pathname === "/upload") {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (body.length === 0 || body.includes(SOURCE_BYTES)) throw new Error("Real-onion upload omitted ciphertext or exposed source bytes.");
      const hash = createHash("sha256").update(body).digest("hex");
      if (request.headers["x-sha-256"] !== hash) throw new Error("Real-onion upload sent the wrong SHA-256 header.");
      if (request.headers["content-type"] !== "application/vnd.forgesworn.encrypted") throw new Error("Real-onion upload exposed the source MIME type.");
      const authorisation = request.headers.authorization;
      if (!authorisation?.startsWith("Nostr ")) throw new Error("Real-onion upload omitted Nostr authorisation.");
      const event = JSON.parse(Buffer.from(authorisation.slice(6), "base64url").toString("utf8"));
      if (!verifyEvent(event) || event.pubkey !== PUBKEY) throw new Error("Real-onion upload authority had an invalid or unexpected signature.");
      const requiredTags = ["t", "expiration", "server", "x"];
      if (event.tags.length !== requiredTags.length
        || !requiredTags.every((name) => event.tags.filter((tag) => tag[0] === name).length === 1)
        || !event.tags.some((tag) => tag[0] === "t" && tag[1] === "upload")
        || !event.tags.some((tag) => tag[0] === "server" && tag[1] === new URL(blossomOnionOrigin).hostname)
        || !event.tags.some((tag) => tag[0] === "x" && tag[1] === hash)) {
        throw new Error("Real-onion upload authority was not exactly scoped to the onion service and payload.");
      }
      blossomAuthorisations.push(event);
      uploadedBytes = body;
      uploadedHash = hash;
      response.writeHead(201, { ...cors, "Content-Type": "application/json" });
      response.end(JSON.stringify({
        url: `${blossomOnionOrigin}/${hash}.wbenc`,
        sha256: hash,
        size: body.length,
        type: "application/vnd.forgesworn.encrypted",
        uploaded: 1_700_000_000,
      }));
      return;
    }
    if (request.method === "GET" && uploadedBytes && url.pathname === `/${uploadedHash}.wbenc`) {
      if (blossomRetrievalMode === "hanging") {
        hangingRetrievalStarted += 1;
        let counted = false;
        const countClosure = () => {
          if (counted) return;
          counted = true;
          hangingRetrievalClosed += 1;
        };
        request.once("aborted", countClosure);
        response.once("close", () => {
          if (!response.writableEnded) countClosure();
        });
        response.writeHead(200, {
          ...cors,
          "Content-Type": "application/vnd.forgesworn.encrypted",
          "Content-Length": String(uploadedBytes.length),
        });
        response.write(uploadedBytes.subarray(0, Math.min(1024, uploadedBytes.length - 1)));
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
    response.writeHead(404, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  })().catch((error) => {
    blossomErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Controlled onion Blossom failure");
  });
});

const relayEvents = new Map();
let relaySilent = false;
const relayErrors = [];
const relayHosts = [];
const relay = new WebSocketServer({ host: HOST, port: 0, maxPayload: 1024 * 1024 });
relay.on("error", (error) => relayErrors.push(error.message));
relay.on("connection", (socket, request) => {
  relayHosts.push(request.headers.host ?? "");
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString("utf8"));
      if (message[0] === "EVENT") {
        const event = message[1];
        if (!verifyEvent(event) || event.pubkey !== PUBKEY) throw new Error("Real-onion relay received an invalid or unexpected signature.");
        relayEvents.set(event.id, event);
        socket.send(JSON.stringify(["OK", event.id, true, "stored by real-onion relay"]));
      }
      if (message[0] === "REQ") {
        if (relaySilent) return;
        const subscription = message[1];
        const event = relayEvents.get(message[2]?.ids?.[0]);
        if (event) socket.send(JSON.stringify(["EVENT", subscription, event]));
        socket.send(JSON.stringify(["EOSE", subscription]));
      }
    } catch (error) {
      relayErrors.push(error instanceof Error ? error.message : String(error));
    }
  });
});

async function createPage(context, label, appOrigin, allowedOrigins, signer) {
  const page = await context.newPage();
  const errors = [];
  const failedRequests = [];
  const undeclaredRequests = [];
  const webSockets = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    failedRequests.push(`${request.method()} ${url.origin}${url.pathname}: ${request.failure()?.errorText ?? "unknown failure"}`);
    if (failedRequests.length > 100) failedRequests.shift();
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!allowedOrigins.has(url.origin)) undeclaredRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
  });
  page.on("websocket", (socket) => webSockets.push(socket.url()));
  await page.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection;
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: false,
      value: class TorForbiddenPeerConnection extends NativePeerConnection {
        constructor(...arguments_) {
          super(...arguments_);
          window.__wildbloomTorWebRtcUsed = true;
        }
      },
    });
    window.__wildbloomTorWebRtcUsed = false;
  });
  if (signer) {
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
    });
  }
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (allowedOrigins.has(url.origin)) await route.continue();
    else await route.abort("blockedbyclient");
  });
  await navigateOnionPage(page, label, appOrigin);
  const capabilities = await page.evaluate(() => ({
    secureContext: window.isSecureContext,
    subtleCrypto: Boolean(window.crypto?.subtle),
  }));
  if (!capabilities.secureContext || !capabilities.subtleCrypto) {
    throw new Error(
      `${label} did not expose the secure Web Crypto context required by Wildbloom `
      + `(secureContext=${capabilities.secureContext}, subtleCrypto=${capabilities.subtleCrypto}).`,
    );
  }
  return { label, page, errors, failedRequests, undeclaredRequests, webSockets };
}

function patternMatches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function pageTransportDiagnostic(record, snapshot) {
  return JSON.stringify({
    status: snapshot,
    pageErrors: record.errors,
    failedRequests: record.failedRequests.slice(-10),
    undeclaredRequests: record.undeclaredRequests,
    webSockets: record.webSockets.slice(-10),
    blossomRequests: blossomRequests.slice(-20),
    blossomErrors,
    relayErrors,
  });
}

async function waitForPageText(record, selector, pattern, timeoutMs = ONION_ACTION_TIMEOUT_MS) {
  let latest = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    latest = await record.page.locator(selector).evaluate((element) => ({
      text: element.textContent ?? "",
      error: element.classList.contains("error"),
      hidden: element.hidden,
      links: element.querySelectorAll("a").length,
    }));
    if (patternMatches(pattern, latest.text)) return;
    if (latest.error) {
      throw new Error(`${record.label} entered an error state before showing ${pattern}: ${pageTransportDiagnostic(record, latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${record.label} did not show ${pattern} within ${timeoutMs}ms: ${pageTransportDiagnostic(record, latest)}`);
}

async function warmOnionTargets(page, blossomOrigin, relayUrl) {
  await waitFor(async () => {
    try {
      return await page.evaluate(async ({ blossom, relay }) => {
        const response = await fetch(blossom, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status !== 404) return false;
        return new Promise((resolve) => {
          const socket = new WebSocket(relay);
          const finish = (ready) => {
            window.clearTimeout(timer);
            socket.close();
            resolve(ready);
          };
          const timer = window.setTimeout(() => finish(false), 10_000);
          socket.addEventListener("open", () => finish(true), { once: true });
          socket.addEventListener("error", () => finish(false), { once: true });
        });
      }, { blossom: blossomOrigin, relay: relayUrl });
    } catch {
      return false;
    }
  }, ONION_ACTION_TIMEOUT_MS, "Controlled Blossom and relay onions did not both become reachable within three minutes.", 1_000);
}

function assertCleanPage(record) {
  if (record.errors.length > 0) throw new Error(`${record.label} page errors: ${record.errors.join("; ")}`);
  if (record.undeclaredRequests.length > 0) throw new Error(`${record.label} made undeclared requests: ${record.undeclaredRequests.join("; ")}`);
}

function usedOnlyExactRelay(record, relayUrl) {
  const expected = new URL(relayUrl);
  return record.webSockets.length > 0 && record.webSockets.every((value) => {
    const actual = new URL(value);
    return actual.protocol === expected.protocol
      && actual.hostname === expected.hostname
      && actual.port === expected.port
      && actual.pathname === "/"
      && actual.search === ""
      && actual.hash === "";
  });
}

async function navigateOnionPage(page, label, appOrigin) {
  const deadline = Date.now() + ONION_ACTION_TIMEOUT_MS;
  let attempts = 0;
  let lastError = "no navigation attempt completed";
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const response = await page.goto(appOrigin, { waitUntil: "load", timeout: 30_000 });
      if (!response?.ok()) throw new Error(`onion document returned HTTP ${response?.status() ?? "no response"}`);
      if (new URL(page.url()).origin !== appOrigin) throw new Error(`onion document left ${appOrigin}`);
      await page.locator("#inspect-file").waitFor({ state: "visible", timeout: 5_000 });
      if (attempts > 1) process.stdout.write(`${label} onion navigation became ready on attempt ${attempts}.\n`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`${label} onion origin did not become reachable within three minutes after ${attempts} attempts: ${lastError}`);
}

async function brandedEvaluate(record, expression, timeoutMs) {
  return record.bidi.evaluateJson(record.context, expression, timeoutMs);
}

async function brandedClick(record, selector) {
  const literal = JSON.stringify(selector);
  return brandedEvaluate(record, `(() => {
    const element = document.querySelector(${literal});
    if (!(element instanceof HTMLElement)) throw new Error("Missing control: " + ${literal});
    if ("disabled" in element && element.disabled) throw new Error("Disabled control: " + ${literal});
    element.click();
    return true;
  })()`);
}

async function brandedSetValue(record, selector, value) {
  const selectorLiteral = JSON.stringify(selector);
  const valueLiteral = JSON.stringify(value);
  return brandedEvaluate(record, `(() => {
    const element = document.querySelector(${selectorLiteral});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error("Missing value control: " + ${selectorLiteral});
    }
    element.value = ${valueLiteral};
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return element.value;
  })()`);
}

async function brandedSetChecked(record, selector, checked) {
  const selectorLiteral = JSON.stringify(selector);
  return brandedEvaluate(record, `(() => {
    const element = document.querySelector(${selectorLiteral});
    if (!(element instanceof HTMLInputElement)) throw new Error("Missing checkable control: " + ${selectorLiteral});
    if (element.disabled) throw new Error("Disabled checkable control: " + ${selectorLiteral});
    if (element.checked !== ${Boolean(checked)}) element.click();
    if (element.checked !== ${Boolean(checked)}) throw new Error("Checkable control did not change: " + ${selectorLiteral});
    return element.checked;
  })()`);
}

async function brandedSnapshot(record, selector) {
  const selectorLiteral = JSON.stringify(selector);
  return brandedEvaluate(record, `(() => {
    const element = document.querySelector(${selectorLiteral});
    if (!(element instanceof HTMLElement)) return null;
    return {
      text: element.textContent ?? "",
      error: element.classList.contains("error"),
      hidden: element.hidden,
      disabled: "disabled" in element ? Boolean(element.disabled) : false,
      links: element.querySelectorAll("a").length,
    };
  })()`);
}

async function waitForBrandedText(record, selector, pattern, timeoutMs = ONION_ACTION_TIMEOUT_MS) {
  let latest = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    latest = await brandedSnapshot(record, selector);
    const text = latest?.text ?? "";
    if (patternMatches(pattern, text)) return;
    if (latest?.error) {
      throw new Error(`${record.label} entered an error state before showing ${pattern}: ${JSON.stringify({
        status: latest,
        requests: record.requests.slice(-20),
        browserOutput: record.output().slice(-2_000),
        blossomRequests: blossomRequests.slice(-20),
        blossomErrors,
        relayErrors,
      })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${record.label} did not show ${pattern} within ${timeoutMs}ms: ${JSON.stringify({
    status: latest,
    requests: record.requests.slice(-20),
    browserOutput: record.output().slice(-2_000),
    blossomRequests: blossomRequests.slice(-20),
    blossomErrors,
    relayErrors,
  })}`);
}

async function warmBrandedOnionTargets(record, blossomOrigin, relayUrl) {
  const blossomLiteral = JSON.stringify(blossomOrigin);
  const relayLiteral = JSON.stringify(relayUrl);
  await waitFor(async () => {
    try {
      return await brandedEvaluate(record, `(async () => {
        const response = await fetch(${blossomLiteral}, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status !== 404) return false;
        return new Promise((resolve) => {
          const socket = new WebSocket(${relayLiteral});
          const finish = (ready) => {
            clearTimeout(timer);
            socket.close();
            resolve(ready);
          };
          const timer = setTimeout(() => finish(false), 10_000);
          socket.addEventListener("open", () => finish(true), { once: true });
          socket.addEventListener("error", () => finish(false), { once: true });
        });
      })()`, 20_000);
    } catch {
      return false;
    }
  }, ONION_ACTION_TIMEOUT_MS, "Branded Tor Browser did not reach the controlled Blossom and relay onions.", 1_000);
}

async function launchBrandedTorBrowser(torBrowser, socksPort, appOrigin, allowedOrigins, ceremony) {
  if (!/^[a-z-]+$/u.test(ceremony)) throw new Error("Branded Tor Browser ceremony name is invalid.");
  const profileDirectory = join(tempRoot, `branded-tor-browser-${ceremony}-profile`);
  const browserDataDirectory = join(tempRoot, `branded-tor-browser-${ceremony}-data`);
  mkdirSync(profileDirectory, { mode: 0o700 });
  mkdirSync(browserDataDirectory, { mode: 0o700 });
  const remotePort = await availablePort();
  writeFileSync(join(profileDirectory, "user.js"), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.page", 0);',
    'user_pref("browser.startup.homepage", "about:blank");',
    'user_pref("network.proxy.type", 1);',
    `user_pref("network.proxy.socks", ${JSON.stringify(HOST)});`,
    `user_pref("network.proxy.socks_port", ${socksPort});`,
    'user_pref("network.proxy.socks_version", 5);',
    'user_pref("network.proxy.socks_remote_dns", true);',
    'user_pref("network.proxy.no_proxies_on", "");',
  ].join("\n") + "\n", { mode: 0o600 });

  let output = "";
  const processHandle = spawn(torBrowser.binary, [
    "--headless",
    "--no-remote",
    "--profile", profileDirectory,
    "--remote-debugging-port", String(remotePort),
    "about:blank",
  ], {
    env: {
      ...process.env,
      MOZ_CRASHREPORTER_DISABLE: "1",
      TOR_BROWSER_DATA_DIR: browserDataDirectory,
      TOR_SKIP_LAUNCH: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const recordOutput = (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-128 * 1024); };
  processHandle.stdout.on("data", recordOutput);
  processHandle.stderr.on("data", recordOutput);

  let bidi;
  await waitFor(async () => {
    if (processHandle.exitCode !== null) throw new Error(`Branded Tor Browser exited before WebDriver BiDi opened: ${output}`);
    try {
      bidi = await WebDriverBiDi.connect(`ws://localhost:${remotePort}/session`, 1_000);
      return true;
    } catch {
      return false;
    }
  }, 30_000, `Branded Tor Browser did not expose loopback WebDriver BiDi: ${output}`, 250);
  if (!bidi) throw new Error("Branded Tor Browser BiDi connection disappeared.");

  const created = await bidi.command("session.new", { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
  const expectedEngine = /Firefox ([0-9.]+)/u.exec(torBrowser.version)?.[1];
  if (!expectedEngine || created.capabilities?.browserVersion !== expectedEngine) {
    throw new Error(`Tor Browser capability version ${created.capabilities?.browserVersion ?? "missing"} did not match ${torBrowser.version}.`);
  }
  await bidi.command("session.subscribe", {
    events: ["network.beforeRequestSent"],
  });
  await bidi.command("script.addPreloadScript", {
    functionDeclaration: `() => {
      window.__wildbloomTorWebRtcUsed = false;
      window.__wildbloomPageErrors = [];
      window.addEventListener("error", (event) => {
        window.__wildbloomPageErrors.push(event.error?.message ?? event.message ?? "unknown page error");
      });
      window.addEventListener("unhandledrejection", (event) => {
        window.__wildbloomPageErrors.push(event.reason?.message ?? String(event.reason ?? "unknown rejected promise"));
      });
      const objectUrls = new Map();
      Object.defineProperty(window, "__wildbloomObservedObjectUrls", {
        configurable: false,
        value: objectUrls,
      });
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
        value: class TorForbiddenPeerConnection extends NativePeerConnection {
          constructor(...arguments_) {
            super(...arguments_);
            window.__wildbloomTorWebRtcUsed = true;
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
    label: `branded ${torBrowser.version}`,
    bidi,
    context,
    output: () => output,
    process: processHandle,
    requests,
  };

  let lastNavigationError = "no navigation attempted";
  await waitFor(async () => {
    try {
      await bidi.command("browsingContext.navigate", { context, url: appOrigin, wait: "complete" }, 30_000);
      const ready = await brandedEvaluate(record, `(() => ({
        marker: Boolean(document.querySelector("#inspect-file")),
        origin: location.origin,
        secureContext: window.isSecureContext,
        subtleCrypto: Boolean(window.crypto?.subtle),
      }))()`);
      if (!ready.marker || ready.origin !== appOrigin || !ready.secureContext || !ready.subtleCrypto) {
        throw new Error(`unexpected app readiness ${JSON.stringify(ready)}`);
      }
      return true;
    } catch (error) {
      lastNavigationError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }, ONION_ACTION_TIMEOUT_MS, () => `Branded Tor Browser did not load the exact secure app onion: ${lastNavigationError}`, 1_000);

  const state = await brandedEvaluate(record, `(() => ({
    hasSigner: Boolean(window.nostr),
    userAgent: navigator.userAgent,
    webRtcUsed: window.__wildbloomTorWebRtcUsed,
  }))()`);
  if (state.hasSigner) throw new Error("Branded Tor Browser unexpectedly exposed a Nostr signer extension.");
  if (state.webRtcUsed) throw new Error("Branded Tor Browser created WebRTC state while opening Wildbloom.");
  const expectedUserAgent = new RegExp(`Firefox/${expectedEngine.split(".")[0]}\\.0`, "u");
  if (!expectedUserAgent.test(state.userAgent)) throw new Error(`Unexpected Tor Browser user agent: ${state.userAgent}`);
  for (const request of requests) {
    const url = new URL(request);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !brandedRequestAllowed(request, allowedOrigins)) {
      throw new Error(`Branded Tor Browser made an undeclared application request to ${request}.`);
    }
  }
  return record;
}

async function closeBrandedTorBrowser(record) {
  if (!record) return;
  await record.bidi.close().catch(() => undefined);
  await stopChild(record.process);
}

async function brandedSetFile(record, selector, bytes, name, mimeType) {
  const selectorLiteral = JSON.stringify(selector);
  const bytesLiteral = JSON.stringify([...bytes]);
  const nameLiteral = JSON.stringify(name);
  const typeLiteral = JSON.stringify(mimeType);
  await brandedEvaluate(record, `(() => {
    const input = document.querySelector(${selectorLiteral});
    if (!(input instanceof HTMLInputElement) || input.type !== "file") throw new Error("Missing file input.");
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(${bytesLiteral})], ${nameLiteral}, { type: ${typeLiteral}, lastModified: 0 }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.files?.[0]?.size ?? -1;
  })()`);
}

async function waitForBrandedUnsignedTemplate(record, expectedKind) {
  let latest = null;
  await waitFor(async () => {
    try {
      latest = await brandedEvaluate(record, `(() => {
        const panel = document.querySelector("#external-signing-panel");
        const field = document.querySelector("#external-unsigned-event");
        if (!(panel instanceof HTMLElement) || panel.hidden || !(field instanceof HTMLTextAreaElement) || !field.value) return null;
        return JSON.parse(field.value);
      })()`);
      return latest?.kind === expectedKind;
    } catch {
      return false;
    }
  }, ONION_ACTION_TIMEOUT_MS, () => `${record.label} did not expose unsigned kind ${expectedKind}: ${JSON.stringify(latest)}`, 200);
  return latest;
}

async function completeBrandedExternalSignature(record, expectedKind) {
  const template = await waitForBrandedUnsignedTemplate(record, expectedKind);
  const signed = finalizeEvent(template, SECRET);
  await brandedSetValue(record, "#external-signed-event", JSON.stringify(signed));
  await brandedClick(record, "#accept-external-signature");
  return signed;
}

async function exerciseBrandedExternalPublisher(record, blossomOrigin, relayUrl) {
  await warmBrandedOnionTargets(record, blossomOrigin, relayUrl);
  await brandedSetChecked(record, 'input[name="network-profile"][value="tor"]', true);
  await brandedSetChecked(record, 'input[name="signing-method"][value="external"]', true);
  await brandedSetValue(record, "#external-signer-pubkey", PUBKEY);
  await brandedSetValue(record, "#blossom-server", blossomOrigin);
  await brandedSetValue(record, "#relay-urls", relayUrl);
  await brandedSetChecked(record, "#tor-consent", true);
  await brandedClick(record, "#connect-signer");
  await waitForBrandedText(record, "#publish-status", /External signer public key confirmed/iu);
  await brandedSetFile(record, "#publish-file", SOURCE_BYTES, "onion-proof.txt", "text/plain");
  await brandedClick(record, "#inspect-file");
  await waitForBrandedText(record, "#publish-status", /Encrypted transfer payload prepared/iu);
  const recoveryKey = await brandedEvaluate(record, `(() => {
    const field = document.querySelector("#recovery-key-output");
    if (!(field instanceof HTMLInputElement)) throw new Error("Recovery key output is missing.");
    return field.value;
  })()`);
  if (!/^wbk1_[A-Za-z0-9_-]{43}$/u.test(recoveryKey)) throw new Error("Branded external publication did not produce a recovery key.");
  await brandedSetChecked(record, "#upload-consent", true);
  await brandedSetChecked(record, "#key-saved-consent", true);
  const uploadsBeforeSignature = blossomRequests.filter((value) => value === "PUT /upload").length;
  await brandedClick(record, "#upload-file");
  await waitForBrandedUnsignedTemplate(record, 24242);
  if (blossomRequests.filter((value) => value === "PUT /upload").length !== uploadsBeforeSignature) {
    throw new Error("Branded external publication uploaded before receiving exact signed authority.");
  }
  await completeBrandedExternalSignature(record, 24242);
  await waitForBrandedText(record, "#publish-status", /No clearnet fallback or torrent metadata/iu);
  const authorisation = blossomAuthorisations.at(-1);
  const expiration = Number(authorisation?.tags.find((tag) => tag[0] === "expiration")?.[1]);
  if (!authorisation || expiration - authorisation.created_at !== 300) {
    throw new Error("Branded external publication did not use the bounded five-minute upload authority.");
  }

  await brandedClick(record, "#sign-events");
  const fileEvent = await completeBrandedExternalSignature(record, 1063);
  await waitForBrandedText(record, "#publish-status", /Exact external signatures accepted/iu);
  await brandedSetChecked(record, "#publish-consent", true);
  await brandedClick(record, "#publish-events");
  await waitForBrandedText(record, "#publish-status", /1\/1 acknowledgements/iu);
  const finalState = await brandedEvaluate(record, `(() => ({
    hasSigner: Boolean(window.nostr),
    webRtcUsed: window.__wildbloomTorWebRtcUsed,
    handoffHidden: document.querySelector("#external-signing-panel")?.hidden,
    seedHidden: document.querySelector("#seed-gate")?.hidden,
  }))()`);
  if (finalState.hasSigner || finalState.webRtcUsed || !finalState.handoffHidden || !finalState.seedHidden) {
    throw new Error(`Branded external publication crossed its signer, WebRTC or Tor boundary: ${JSON.stringify(finalState)}`);
  }
  return { eventId: fileEvent.id, recoveryKey };
}

async function exerciseBrandedRetriever(record, blossomOrigin, relayUrl, eventId, recoveryKey) {
  await warmBrandedOnionTargets(record, blossomOrigin, relayUrl);
  await brandedSetChecked(record, 'input[name="network-profile"][value="tor"]', true);
  await brandedSetValue(record, "#blossom-server", blossomOrigin);
  await brandedSetValue(record, "#relay-urls", relayUrl);
  await brandedSetChecked(record, "#tor-consent", true);
  await brandedSetValue(record, "#event-id", eventId);
  const torState = await brandedEvaluate(record, `(() => ({
    hasSigner: Boolean(window.nostr),
    seedHidden: document.querySelector("#seed-gate")?.hidden,
    swarmDisabled: document.querySelector("#fetch-swarm")?.disabled,
    trackerHidden: document.querySelector("#tracker-field")?.hidden,
  }))()`);
  if (torState.hasSigner || !torState.seedHidden || !torState.swarmDisabled || !torState.trackerHidden) {
    throw new Error(`Branded Tor Browser did not retain the signer-free Tor-only boundary: ${JSON.stringify(torState)}`);
  }

  relaySilent = true;
  try {
    await brandedClick(record, "#resolve-event");
    await waitForBrandedText(record, "#retrieve-status", /lookup timed out/iu, 30_000);
    const timedOut = await brandedEvaluate(record, `(() => ({
      blossomDisabled: document.querySelector("#fetch-blossom")?.disabled,
      links: document.querySelectorAll("#retrieve-links a").length,
      resolveDisabled: document.querySelector("#resolve-event")?.disabled,
    }))()`);
    if (timedOut.blossomDisabled !== true || timedOut.links !== 0 || timedOut.resolveDisabled !== false) {
      throw new Error(`A timed-out branded relay lookup retained authority: ${JSON.stringify(timedOut)}`);
    }
  } finally {
    relaySilent = false;
  }

  await brandedClick(record, "#resolve-event");
  await waitForBrandedText(record, "#retrieve-status", /separately received recovery key/iu);

  const startedBefore = hangingRetrievalStarted;
  const closedBefore = hangingRetrievalClosed;
  blossomRetrievalMode = "hanging";
  try {
    await brandedSetValue(record, "#recovery-key-input", recoveryKey);
    await brandedClick(record, "#fetch-blossom");
    await waitFor(
      () => hangingRetrievalStarted > startedBefore,
      30_000,
      "Branded Tor Browser did not begin the controlled partial onion retrieval.",
    );
    await brandedClick(record, "#cancel-download");
    await waitForBrandedText(record, "#retrieve-status", /retrieval cancelled/iu, 30_000);
    await waitFor(
      () => hangingRetrievalClosed > closedBefore,
      30_000,
      "Cancelling the branded Tor Browser retrieval did not close the onion response.",
    );
    const cancelled = await brandedEvaluate(record, `(() => ({
      cancelDisabled: document.querySelector("#cancel-download")?.disabled,
      links: document.querySelectorAll("#retrieve-links a").length,
    }))()`);
    if (!cancelled.cancelDisabled || cancelled.links !== 0) {
      throw new Error(`Cancelled branded retrieval retained stale output: ${JSON.stringify(cancelled)}`);
    }
  } finally {
    blossomRetrievalMode = "normal";
  }

  await brandedSetValue(record, "#recovery-key-input", recoveryKey);
  await brandedClick(record, "#fetch-blossom");
  await waitForBrandedText(record, "#retrieve-status", /locally decrypted bytes/iu);
  const recovered = await brandedEvaluate(record, `(async () => {
    const link = document.querySelector("#retrieve-links a");
    if (!(link instanceof HTMLAnchorElement)) throw new Error("Verified branded download link is missing.");
    const blob = window.__wildbloomObservedObjectUrls?.get(link.href);
    if (!(blob instanceof Blob)) throw new Error("Verified branded download Blob was not observed.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes: Array.from(bytes), name: link.download, type: blob.type, rel: link.rel };
  })()`);
  if (recovered.name !== "onion-proof.txt"
    || recovered.type !== "application/octet-stream"
    || !recovered.rel.includes("noopener")
    || !Buffer.from(recovered.bytes).equals(SOURCE_BYTES)) {
    throw new Error("Branded Tor Browser recovery did not reproduce the exact source file.");
  }
  const finalState = await brandedEvaluate(record, `(() => ({
    hasSigner: Boolean(window.nostr),
    webRtcUsed: window.__wildbloomTorWebRtcUsed,
  }))()`);
  if (finalState.hasSigner || finalState.webRtcUsed) {
    throw new Error(`Branded recovery crossed its signer or WebRTC boundary: ${JSON.stringify(finalState)}`);
  }
}

async function assertBrandedPageClean(record, allowedOrigins) {
  const errors = await brandedEvaluate(record, `(() => [...window.__wildbloomPageErrors])()`);
  if (errors.length > 0) throw new Error(`Branded Tor Browser uncaught page errors: ${errors.join("; ")}`);
  for (const request of record.requests) {
    const url = new URL(request);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !brandedRequestAllowed(request, allowedOrigins)) {
      throw new Error(`Branded Tor Browser made an undeclared application request to ${request}.`);
    }
  }
}

let torProcess;
let production;
let browser;
let publisherContext;
let retrieverContext;
let brandedRecord;
let brandedRecoveryKey;
let blossomClosed = false;
let torLog = "";
try {
  const torBrowser = brandedTorBrowserRequested() ? findTorBrowser() : null;
  await Promise.all([listen(blossom), new Promise((resolve, reject) => {
    relay.once("listening", resolve);
    relay.once("error", reject);
  })]);
  const blossomAddress = blossom.address();
  const relayAddress = relay.address();
  if (!blossomAddress || typeof blossomAddress === "string") throw new Error("Onion Blossom target did not expose a port.");
  if (!relayAddress || typeof relayAddress === "string") throw new Error("Onion relay target did not expose a port.");
  const [appPort, socksPort, controlPort] = await Promise.all([availablePort(), availablePort(), availablePort()]);

  torProcess = spawn(findTor(), [
    "--DataDirectory", torData,
    "--SocksPort", `${HOST}:${socksPort}`,
    "--ControlPort", `${HOST}:${controlPort}`,
    "--CookieAuthentication", "1",
    "--AvoidDiskWrites", "1",
    "--SafeLogging", "1",
    "--HiddenServiceDir", appService,
    "--HiddenServiceVersion", "3",
    "--HiddenServicePort", `80 ${HOST}:${appPort}`,
    "--HiddenServiceDir", blossomService,
    "--HiddenServiceVersion", "3",
    "--HiddenServicePort", `80 ${HOST}:${blossomAddress.port}`,
    "--HiddenServiceDir", relayService,
    "--HiddenServiceVersion", "3",
    "--HiddenServicePort", `80 ${HOST}:${relayAddress.port}`,
    "--Log", "notice stdout",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const recordTorOutput = (chunk) => { torLog = `${torLog}${chunk.toString("utf8")}`.slice(-128 * 1024); };
  torProcess.stdout.on("data", recordTorOutput);
  torProcess.stderr.on("data", recordTorOutput);
  const controlCookie = join(torData, "control_auth_cookie");
  let bootstrapTranscript = "no control transcript";
  await waitFor(async () => {
    if (torProcess.exitCode !== null) throw new Error(`Tor exited before bootstrap with code ${torProcess.exitCode}: ${torLog}`);
    try {
      const transcript = await controlTranscript(controlPort, controlCookie, ["GETINFO status/bootstrap-phase"]);
      bootstrapTranscript = transcript;
      return /PROGRESS=100(?:\s|$)/u.test(transcript);
    } catch (error) {
      bootstrapTranscript = error instanceof Error ? error.message : String(error);
      return false;
    }
  }, TOR_BOOTSTRAP_TIMEOUT_MS, () => `Tor control port did not report 100% bootstrap within five minutes. Latest control result: ${bootstrapTranscript}. Tor log: ${torLog || "no Tor log output"}`, 2_000);
  await waitFor(() => onionHostname(appService) && onionHostname(blossomService) && onionHostname(relayService), 10_000, "Tor did not create all v3 onion hostnames.");
  process.stdout.write("Tor bootstrap reached 100% and three disposable v3 service identities are ready.\n");
  const appHost = onionHostname(appService);
  const blossomHost = onionHostname(blossomService);
  const relayHost = onionHostname(relayService);
  if (!appHost || !blossomHost || !relayHost) throw new Error("Tor onion hostnames disappeared after bootstrap.");
  const appOrigin = `http://${appHost}`;
  blossomOnionOrigin = `http://${blossomHost}`;
  const relayUrl = `ws://${relayHost}`;

  production = spawn(process.execPath, ["scripts/serve-production.mjs", "--host", HOST, "--port", String(appPort)], {
    env: { ...process.env, WILDBLOOM_ALLOWED_HOSTS: `${appHost},${HOST},localhost` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(async () => {
    if (production.exitCode !== null) throw new Error(`Production server exited early with ${production.exitCode}.`);
    try {
      return (await fetch(`http://${HOST}:${appPort}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 10_000, "Production server did not start behind the onion service.");

  const browserName = requestedBrowser();
  browser = await chromium.launch({
    headless: true,
    executablePath: findChrome(),
    // Chromium does not classify HTTP onion origins as potentially trustworthy.
    // This override lets Chromium exercise the required Web Crypto path while
    // branded Tor Browser behaviour is exercised separately below when asked.
    args: [`--unsafely-treat-insecure-origin-as-secure=${appOrigin}`],
    proxy: { server: `socks5://${HOST}:${socksPort}` },
  });
  const allowedOrigins = new Set([appOrigin, blossomOnionOrigin, new URL(relayUrl).origin]);
  publisherContext = await browser.newContext({ acceptDownloads: true });
  const publisher = await createPage(publisherContext, "onion publisher", appOrigin, allowedOrigins, true);
  if (publisher.undeclaredRequests.length > 0) throw new Error(`Opening the onion app made ambient requests: ${publisher.undeclaredRequests.join("; ")}`);
  await warmOnionTargets(publisher.page, blossomOnionOrigin, relayUrl);
  process.stdout.write("The production app, controlled Blossom target and controlled relay are reachable only through their onion origins.\n");
  await publisher.page.check('input[name="network-profile"][value="tor"]');
  await publisher.page.fill("#blossom-server", blossomOnionOrigin);
  await publisher.page.fill("#relay-urls", relayUrl);
  await publisher.page.check("#tor-consent");
  await publisher.page.click("#connect-signer");
  await publisher.page.setInputFiles("#publish-file", { name: "onion-proof.txt", mimeType: "text/plain", buffer: SOURCE_BYTES });
  await publisher.page.click("#inspect-file");
  await publisher.page.locator("#publish-status").filter({ hasText: "Encrypted transfer payload prepared" }).waitFor();
  const recoveryKey = await publisher.page.inputValue("#recovery-key-output");
  await publisher.page.check("#upload-consent");
  await publisher.page.check("#key-saved-consent");
  await publisher.page.click("#upload-file");
  await publisher.page.locator("#publish-status").filter({ hasText: "No clearnet fallback" }).waitFor({ timeout: ONION_ACTION_TIMEOUT_MS });
  if (!uploadedBytes || !uploadedHash) throw new Error("Encrypted payload did not traverse the real Blossom onion service.");
  await publisher.page.click("#sign-events");
  await publisher.page.locator("#publish-status").filter({ hasText: "Signed locally through NIP-07" }).waitFor();
  const signedStatus = await publisher.page.locator("#publish-status").textContent();
  const eventId = /1063: ([0-9a-f]{64})/u.exec(signedStatus ?? "")?.[1];
  if (!eventId || (signedStatus?.match(/[0-9]+: [0-9a-f]{64}/gu) ?? []).length !== 1) {
    throw new Error("Tor-only publication did not stage exactly one NIP-94 event.");
  }
  await publisher.page.check("#publish-consent");
  await publisher.page.click("#publish-events");
  await publisher.page.locator("#publish-status").filter({ hasText: "1/1 acknowledgements" }).waitFor({ timeout: ONION_ACTION_TIMEOUT_MS });
  if (await publisher.page.evaluate(() => window.__wildbloomTorWebRtcUsed)) throw new Error("Tor-only publication created WebRTC state.");

  await publisherContext.close();
  publisherContext = undefined;
  await signalNewIdentity(controlPort, controlCookie);
  process.stdout.write("Tor acknowledged NEWNYM after encrypted publication.\n");
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  retrieverContext = await browser.newContext({ acceptDownloads: true });
  const retriever = await createPage(retrieverContext, "onion retriever", appOrigin, allowedOrigins, false);
  await warmOnionTargets(retriever.page, blossomOnionOrigin, relayUrl);
  process.stdout.write("The rotated identity reached the controlled Blossom and relay onions before retrieval.\n");
  await retriever.page.check('input[name="network-profile"][value="tor"]');
  await retriever.page.fill("#blossom-server", blossomOnionOrigin);
  await retriever.page.fill("#relay-urls", relayUrl);
  await retriever.page.check("#tor-consent");
  await retriever.page.fill("#event-id", eventId);
  await retriever.page.click("#resolve-event");
  await waitForPageText(retriever, "#retrieve-status", /separately received recovery key/iu);
  await retriever.page.fill("#recovery-key-input", recoveryKey);
  await retriever.page.click("#fetch-blossom");
  await waitForPageText(retriever, "#retrieve-status", /locally decrypted bytes/iu);
  const downloadPromise = retriever.page.waitForEvent("download");
  await retriever.page.getByRole("link", { name: "Save verified onion-proof.txt" }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (!downloadedPath || !readFileSync(downloadedPath).equals(SOURCE_BYTES)) throw new Error("Real-onion recovery did not reproduce the source bytes.");
  if (await retriever.page.evaluate(() => window.__wildbloomTorWebRtcUsed)) throw new Error("Tor-only retrieval created WebRTC state.");
  if (retriever.page.url() !== `${appOrigin}/`) throw new Error("Retriever left the exact app onion origin.");

  if (torBrowser) {
    await signalNewIdentity(controlPort, controlCookie);
    process.stdout.write(`Tor acknowledged NEWNYM before the ${torBrowser.version} extension-free publication ceremony.\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    brandedRecord = await launchBrandedTorBrowser(torBrowser, socksPort, appOrigin, allowedOrigins, "publisher");
    const brandedPublication = await exerciseBrandedExternalPublisher(brandedRecord, blossomOnionOrigin, relayUrl);
    brandedRecoveryKey = brandedPublication.recoveryKey;
    await assertBrandedPageClean(brandedRecord, allowedOrigins);
    await closeBrandedTorBrowser(brandedRecord);
    brandedRecord = undefined;

    await signalNewIdentity(controlPort, controlCookie);
    process.stdout.write(`Tor acknowledged NEWNYM before the fresh ${torBrowser.version} signer-free retrieval ceremony.\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    brandedRecord = await launchBrandedTorBrowser(torBrowser, socksPort, appOrigin, allowedOrigins, "retriever");
    await exerciseBrandedRetriever(
      brandedRecord,
      blossomOnionOrigin,
      relayUrl,
      brandedPublication.eventId,
      brandedPublication.recoveryKey,
    );
    process.stdout.write(`${torBrowser.version} externally signed and published encrypted metadata without an add-on, then a fresh profile recovered the exact source after NEWNYM, bounded relay timeout and download-cancellation checks.\n`);
  }

  await closeServer(blossom);
  blossomClosed = true;
  await retriever.page.fill("#recovery-key-input", recoveryKey);
  await retriever.page.click("#fetch-blossom");
  await retriever.page.locator("#retrieve-status.error").waitFor({ timeout: ONION_ACTION_TIMEOUT_MS });
  if (await retriever.page.locator("#retrieve-links a").count() !== 0) throw new Error("Denied onion retrieval retained a stale verified download.");
  if (brandedRecord) {
    await brandedSetValue(brandedRecord, "#recovery-key-input", brandedRecoveryKey ?? recoveryKey);
    await brandedClick(brandedRecord, "#fetch-blossom");
    await waitForBrandedText(brandedRecord, "#retrieve-status", /retrieval failed|network|fetch/iu);
    const deniedLinks = await brandedSnapshot(brandedRecord, "#retrieve-links");
    const deniedStatus = await brandedSnapshot(brandedRecord, "#retrieve-status");
    if (deniedLinks?.links !== 0 || deniedStatus?.error !== true) {
      throw new Error(`Denied branded Tor Browser retrieval retained stale or non-error state: ${JSON.stringify({ deniedLinks, deniedStatus })}.`);
    }
    await assertBrandedPageClean(brandedRecord, allowedOrigins);
  }

  assertCleanPage(publisher);
  assertCleanPage(retriever);
  if (!usedOnlyExactRelay(publisher, relayUrl) || !usedOnlyExactRelay(retriever, relayUrl)) {
    throw new Error("Publication and retrieval did not both use the exact onion relay.");
  }
  if (!blossomHosts.every((host) => host === blossomHost) || !relayHosts.every((host) => host === relayHost)) {
    throw new Error("An onion target received a non-onion Host authority.");
  }
  if (blossomErrors.length > 0) throw new Error(`Real-onion Blossom errors: ${blossomErrors.join("; ")}`);
  if (relayErrors.length > 0) throw new Error(`Real-onion relay errors: ${relayErrors.join("; ")}`);

  const brandedResult = torBrowser
    ? ` ${torBrowser.version} also completed exact external-signature publication without an add-on, then signer-free recovery, relay timeout, cancellation and denied-service checks through a fresh profile after NEWNYM; headless WebDriver BiDi evidence is not a manual Tor Browser usability review.`
    : " Branded Tor Browser interaction remains a separate release gate.";
  process.stdout.write(
    `Tor transport acceptance passed in ${browserName} with a harness-only secure-origin override through Tor ${/(?:Tor version |Tor )([0-9]+(?:\.[0-9]+)+)/u.exec(torLog)?.[1] ?? "unknown"}: disposable v3 onion app, Blossom and Nostr relay completed encrypted publication and exact recovery after NEWNYM, refused WebRTC and failed closed after the Blossom target was denied.${brandedResult}\n`,
  );
} finally {
  await closeBrandedTorBrowser(brandedRecord).catch(() => undefined);
  if (retrieverContext) await retrieverContext.close().catch(() => undefined);
  if (publisherContext) await publisherContext.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (!blossomClosed) await closeServer(blossom).catch(() => undefined);
  await closeServer(relay).catch(() => undefined);
  await stopChild(production);
  await stopChild(torProcess);
  rmSync(tempRoot, { recursive: true, force: true });
}
