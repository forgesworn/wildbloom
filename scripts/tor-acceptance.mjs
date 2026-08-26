import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";

const HOST = "127.0.0.1";
const ONION_ACTION_TIMEOUT_MS = 3 * 60 * 1000;
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
  throw new Error(message);
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
const blossomErrors = [];
const blossomHosts = [];
const blossom = createHttpServer((request, response) => {
  void (async () => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Cache-Control, Content-Type, Range, X-SHA-256",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    };
    blossomHosts.push(request.headers.host ?? "");
    const url = new URL(request.url ?? "/", blossomOnionOrigin ?? "http://placeholder.onion");
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
      if (request.headers["content-type"] !== "application/vnd.wildbloom.encrypted") throw new Error("Real-onion upload exposed the source MIME type.");
      const authorisation = request.headers.authorization;
      if (!authorisation?.startsWith("Nostr ")) throw new Error("Real-onion upload omitted Nostr authorisation.");
      const event = JSON.parse(Buffer.from(authorisation.slice(6), "base64url").toString("utf8"));
      if (!event.tags.some((tag) => tag[0] === "server" && tag[1] === new URL(blossomOnionOrigin).hostname)) {
        throw new Error("Real-onion upload authority was not scoped to the onion service.");
      }
      uploadedBytes = body;
      uploadedHash = hash;
      response.writeHead(201, { ...cors, "Content-Type": "application/json" });
      response.end(JSON.stringify({
        url: `${blossomOnionOrigin}/${hash}.wbenc`,
        sha256: hash,
        size: body.length,
        type: "application/vnd.wildbloom.encrypted",
        uploaded: 1_700_000_000,
      }));
      return;
    }
    if (request.method === "GET" && uploadedBytes && url.pathname === `/${uploadedHash}.wbenc`) {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "application/vnd.wildbloom.encrypted",
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
        relayEvents.set(event.id, event);
        socket.send(JSON.stringify(["OK", event.id, true, "stored by real-onion relay"]));
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
  });
});

async function createPage(context, label, appOrigin, allowedOrigins, signer) {
  const page = await context.newPage();
  const errors = [];
  const undeclaredRequests = [];
  const webSockets = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
  return { label, page, errors, undeclaredRequests, webSockets };
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

let torProcess;
let production;
let browser;
let publisherContext;
let retrieverContext;
let blossomClosed = false;
let torLog = "";
try {
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
  await waitFor(async () => {
    if (torProcess.exitCode !== null) throw new Error(`Tor exited before bootstrap with code ${torProcess.exitCode}: ${torLog}`);
    try {
      const transcript = await controlTranscript(controlPort, controlCookie, ["GETINFO status/bootstrap-phase"]);
      return /PROGRESS=100(?:\s|$)/u.test(transcript);
    } catch {
      return false;
    }
  }, 180_000, `Tor control port did not report 100% bootstrap within three minutes: ${torLog || "no Tor log output"}`, 500);
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
    // branded Tor Browser behaviour remains a separate manual release gate.
    args: [`--unsafely-treat-insecure-origin-as-secure=${appOrigin}`],
    proxy: { server: `socks5://${HOST}:${socksPort}` },
  });
  const allowedOrigins = new Set([appOrigin, blossomOnionOrigin]);
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
  await retriever.page.locator("#retrieve-status").filter({ hasText: "separately received recovery key" }).waitFor({ timeout: ONION_ACTION_TIMEOUT_MS });
  await retriever.page.fill("#recovery-key-input", recoveryKey);
  await retriever.page.click("#fetch-blossom");
  await retriever.page.locator("#retrieve-status").filter({ hasText: "locally decrypted bytes" }).waitFor({ timeout: ONION_ACTION_TIMEOUT_MS });
  const downloadPromise = retriever.page.waitForEvent("download");
  await retriever.page.getByRole("link", { name: "Save verified onion-proof.txt" }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (!downloadedPath || !readFileSync(downloadedPath).equals(SOURCE_BYTES)) throw new Error("Real-onion recovery did not reproduce the source bytes.");
  if (await retriever.page.evaluate(() => window.__wildbloomTorWebRtcUsed)) throw new Error("Tor-only retrieval created WebRTC state.");
  if (retriever.page.url() !== `${appOrigin}/`) throw new Error("Retriever left the exact app onion origin.");

  await closeServer(blossom);
  blossomClosed = true;
  await retriever.page.fill("#recovery-key-input", recoveryKey);
  await retriever.page.click("#fetch-blossom");
  await retriever.page.locator("#retrieve-status.error").waitFor({ timeout: ONION_ACTION_TIMEOUT_MS });
  if (await retriever.page.locator("#retrieve-links a").count() !== 0) throw new Error("Denied onion retrieval retained a stale verified download.");

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

  process.stdout.write(
    `Tor transport acceptance passed in ${browserName} with a harness-only secure-origin override through Tor ${/(?:Tor version |Tor )([0-9]+(?:\.[0-9]+)+)/u.exec(torLog)?.[1] ?? "unknown"}: disposable v3 onion app, Blossom and Nostr relay completed encrypted publication and exact recovery after NEWNYM, refused WebRTC and failed closed after the Blossom target was denied. Branded Tor Browser interaction remains a manual release gate.\n`,
  );
} finally {
  if (retrieverContext) await retrieverContext.close().catch(() => undefined);
  if (publisherContext) await publisherContext.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (!blossomClosed) await closeServer(blossom).catch(() => undefined);
  await closeServer(relay).catch(() => undefined);
  await stopChild(production);
  await stopChild(torProcess);
  rmSync(tempRoot, { recursive: true, force: true });
}
