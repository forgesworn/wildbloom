import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { accessSync, constants, createReadStream } from "node:fs";
import { createServer } from "node:http";
import { platform } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";

const HOST = "127.0.0.1";
const MEBIBYTE = 1024 * 1024;
const MAXIMUM_SOURCE_BYTES = 256 * MEBIBYTE;
const V8_HEAP_CAP_MIB = 256;
const SECRET = new Uint8Array(32).fill(23);
const PUBKEY = getPublicKey(SECRET);

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
  for (const candidate of candidates.filter(Boolean)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit browser path.
    }
  }
  throw new Error("Maximum-file acceptance requires system Chrome or Chromium.");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, HOST);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function availablePort() {
  const reservation = createServer();
  await listen(reservation);
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a production port.");
  await closeServer(reservation);
  return address.port;
}

async function waitForServer(child, origin) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Production server exited early with ${child.exitCode}.`);
    try {
      if ((await fetch(`${origin}/healthz`)).ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Production server did not become ready.");
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

async function selectGeneratedFile(page, size, name) {
  await page.evaluate(({ bytes, fileName, mebibyte }) => {
    const wholeChunks = Math.floor(bytes / mebibyte);
    const remainder = bytes % mebibyte;
    const reusableZeroChunk = new Uint8Array(mebibyte);
    const parts = Array.from({ length: wholeChunks }, () => reusableZeroChunk);
    if (remainder > 0) parts.push(new Uint8Array(remainder));
    const file = new File(parts, fileName, { type: "application/octet-stream", lastModified: 0 });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector("#publish-file");
    if (!(input instanceof HTMLInputElement)) throw new Error("File input is missing.");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { bytes: size, fileName: name, mebibyte: MEBIBYTE });
}

function sourceHash() {
  const hash = createHash("sha256");
  const zeroChunk = Buffer.alloc(MEBIBYTE);
  for (let index = 0; index < 256; index += 1) hash.update(zeroChunk);
  return hash.digest("hex");
}

function expectedEnvelopeBytes() {
  const metadata = new TextEncoder().encode(JSON.stringify({
    name: "maximum.bin",
    size: MAXIMUM_SOURCE_BYTES,
    type: "application/octet-stream",
  }));
  const plaintextBytes = Math.ceil((4 + metadata.length + MAXIMUM_SOURCE_BYTES) / MEBIBYTE) * MEBIBYTE;
  const recordCount = plaintextBytes / MEBIBYTE;
  return 24 + plaintextBytes + recordCount * 16;
}

async function hashDownloadedFile(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { hash: hash.digest("hex"), size };
}

async function waitForStatus(page, selector, expected, timeoutMs = 5 * 60 * 1000) {
  const target = page.locator(selector);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    lastStatus = await target.textContent() ?? "";
    if (await target.evaluate((element) => element.classList.contains("error"))) {
      throw new Error(`${selector} failed before reaching ${JSON.stringify(expected)}: ${lastStatus}`);
    }
    if (lastStatus.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${selector} did not reach ${JSON.stringify(expected)}; last status: ${lastStatus}`);
}

let blossomOrigin;
let uploadedParts = [];
let uploadedHash;
let uploadedSize = 0;
const blossomErrors = [];
const blossom = createServer((request, response) => {
  void (async () => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Cache-Control, Content-Type, X-SHA-256",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    };
    const url = new URL(request.url ?? "/", blossomOrigin ?? `http://${HOST}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method === "PUT" && url.pathname === "/upload") {
      const parts = [];
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > expectedEnvelopeBytes()) throw new Error("Maximum upload exceeded the exact envelope size.");
        hash.update(bytes);
        parts.push(bytes);
      }
      const digest = hash.digest("hex");
      if (size !== expectedEnvelopeBytes()) throw new Error("Maximum upload was not the exact encrypted envelope size.");
      if (request.headers["content-type"] !== "application/vnd.wildbloom.encrypted") {
        throw new Error("Maximum upload exposed the source MIME type.");
      }
      if (request.headers["x-sha-256"] !== digest) throw new Error("Maximum upload sent the wrong SHA-256 header.");
      const authorisation = request.headers.authorization;
      if (!authorisation?.startsWith("Nostr ")) throw new Error("Maximum upload omitted Nostr authorisation.");
      const event = JSON.parse(Buffer.from(authorisation.slice(6), "base64url").toString("utf8"));
      if (!verifyEvent(event) || event.pubkey !== PUBKEY) throw new Error("Maximum upload authorisation was not validly signed.");
      if (!event.tags.some((tag) => tag[0] === "server" && tag[1] === HOST)) {
        throw new Error("Maximum upload authorisation was not scoped to the controlled server.");
      }
      if (!event.tags.some((tag) => tag[0] === "x" && tag[1] === digest)) {
        throw new Error("Maximum upload authorisation was not scoped to the exact envelope hash.");
      }
      uploadedParts = parts;
      uploadedHash = digest;
      uploadedSize = size;
      response.writeHead(201, { ...cors, "Content-Type": "application/json" });
      response.end(JSON.stringify({
        url: `${blossomOrigin}/${digest}.wbenc`,
        sha256: digest,
        size,
        type: "application/vnd.wildbloom.encrypted",
        uploaded: 1_700_000_000,
      }));
      return;
    }
    if (request.method === "GET" && uploadedHash && url.pathname === `/${uploadedHash}.wbenc`) {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "application/vnd.wildbloom.encrypted",
        "Content-Length": String(uploadedSize),
      });
      for (const part of uploadedParts) {
        if (!response.write(part)) await once(response, "drain");
      }
      response.end();
      return;
    }
    response.writeHead(404, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  })().catch((error) => {
    blossomErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Controlled maximum-file Blossom failure");
  });
});

const relayHttp = createServer();
const relay = new WebSocketServer({ server: relayHttp, maxPayload: 1024 * 1024 });
const relayEvents = new Map();
const relayErrors = [];
relay.on("error", (error) => relayErrors.push(error.message));
relay.on("connection", (socket) => socket.on("message", (raw) => {
  try {
    const message = JSON.parse(raw.toString("utf8"));
    if (message[0] === "EVENT") {
      const event = message[1];
      if (!verifyEvent(event)) throw new Error("Maximum-file relay received an invalid signature.");
      relayEvents.set(event.id, event);
      socket.send(JSON.stringify(["OK", event.id, true, "stored by maximum-file relay"]));
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

const port = await availablePort();
const origin = `http://${HOST}:${port}`;
let production;
let browser;
try {
  await Promise.all([listen(blossom), listen(relayHttp)]);
  const blossomAddress = blossom.address();
  const relayAddress = relayHttp.address();
  if (!blossomAddress || typeof blossomAddress === "string") throw new Error("Maximum-file Blossom did not expose a port.");
  if (!relayAddress || typeof relayAddress === "string") throw new Error("Maximum-file relay did not expose a port.");
  blossomOrigin = `http://${HOST}:${blossomAddress.port}`;
  const relayUrl = `ws://${HOST}:${relayAddress.port}`;
  production = spawn(process.execPath, ["scripts/serve-production.mjs", "--host", HOST, "--port", String(port)], {
    env: { ...process.env, WILDBLOOM_ALLOWED_HOSTS: HOST },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(production, origin);
  browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      `--js-flags=--max-old-space-size=${V8_HEAP_CAP_MIB}`,
      "--enable-precise-memory-info",
    ],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5 * 60 * 1000);
  const undeclaredRequests = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.origin === blossomOrigin) await route.continue();
    else {
      undeclaredRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
    }
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  if (undeclaredRequests.length > 0) {
    throw new Error(`Maximum-file page made ambient requests: ${undeclaredRequests.join("; ")}`);
  }
  // Playwright route interception serialises request bodies through its
  // control pipe. Remove it before the 269 MiB controlled upload so the test
  // measures the browser-to-Blossom path rather than Playwright's string cap.
  await page.unroute("**/*");
  const heapLimit = await page.evaluate(() => performance.memory?.jsHeapSizeLimit ?? 0);
  if (heapLimit === 0 || heapLimit > 384 * MEBIBYTE) {
    throw new Error(`Chrome did not apply the intended constrained JS heap (${heapLimit} bytes reported).`);
  }

  await page.fill("#blossom-server", blossomOrigin);
  await page.fill("#relay-urls", relayUrl);
  await page.fill("#tracker-urls", relayUrl);
  await page.click("#connect-signer");

  await selectGeneratedFile(page, MAXIMUM_SOURCE_BYTES, "maximum.bin");
  const startedAt = Date.now();
  await page.click("#inspect-file");
  await waitForStatus(page, "#publish-status", "Encrypted transfer payload prepared");
  const facts = await page.locator("#file-facts").evaluate((list) => {
    const entries = {};
    for (let index = 0; index < list.children.length; index += 2) {
      const term = list.children[index]?.textContent ?? "";
      const description = list.children[index + 1]?.textContent ?? "";
      entries[term] = description;
    }
    return entries;
  });
  if (facts["Source bytes"] !== String(MAXIMUM_SOURCE_BYTES)) throw new Error("Maximum source byte count was not preserved.");
  const expectedSourceHash = sourceHash();
  if (facts["Source SHA-256"] !== expectedSourceHash) throw new Error("Maximum source bytes produced the wrong SHA-256.");
  if (facts["Public bytes"] !== String(expectedEnvelopeBytes())) throw new Error("Maximum encrypted envelope had an unexpected size.");
  if (facts["Public payload"] !== "wildbloom.wbenc") throw new Error("Maximum source metadata leaked into the public payload name.");
  const recoveryKey = await page.inputValue("#recovery-key-output");
  if (!/^wbk1_[A-Za-z0-9_-]{43}$/u.test(recoveryKey)) {
    throw new Error("Maximum encryption did not produce a recovery key.");
  }

  await page.check("#upload-consent");
  await page.check("#key-saved-consent");
  await page.click("#upload-file");
  await waitForStatus(page, "#publish-status", "hybrid metadata is staged");
  if (!uploadedHash || uploadedSize !== expectedEnvelopeBytes()) throw new Error("Maximum encrypted upload was not retained exactly.");
  await page.click("#sign-events");
  await waitForStatus(page, "#publish-status", "Signed locally through NIP-07");
  const signedStatus = await page.locator("#publish-status").textContent();
  const eventId = /1063: ([0-9a-f]{64})/u.exec(signedStatus ?? "")?.[1];
  if (!eventId) throw new Error("Maximum workflow did not produce a NIP-94 event ID.");
  await page.check("#publish-consent");
  await page.click("#publish-events");
  await waitForStatus(page, "#publish-status", "2/2 acknowledgements");

  await page.fill("#event-id", eventId);
  await page.click("#resolve-event");
  await waitForStatus(page, "#retrieve-status", "separately received recovery key");
  await page.fill("#recovery-key-input", recoveryKey);
  await page.click("#fetch-blossom");
  await waitForStatus(page, "#retrieve-status", "locally decrypted bytes");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Save verified maximum.bin" }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error("Maximum recovery did not create a download.");
  const downloaded = await hashDownloadedFile(downloadedPath);
  if (downloaded.size !== MAXIMUM_SOURCE_BYTES || downloaded.hash !== expectedSourceHash) {
    throw new Error("Maximum recovery did not reproduce the exact 256 MiB source.");
  }

  await page.goto(origin, { waitUntil: "networkidle" });
  await selectGeneratedFile(page, MAXIMUM_SOURCE_BYTES + 1, "too-large.bin");
  await page.click("#inspect-file");
  await page.locator("#publish-status.error").filter({ hasText: "limited to 256 MiB" }).waitFor({ timeout: 10_000 });
  if (!(await page.isHidden("#recovery-key-panel")) || await page.isEnabled("#upload-file")) {
    throw new Error("Oversized rejection retained recovery material or upload authority.");
  }
  if (pageErrors.length > 0) throw new Error(`Maximum-file page errors: ${pageErrors.join("; ")}`);
  if (blossomErrors.length > 0) throw new Error(`Maximum-file Blossom errors: ${blossomErrors.join("; ")}`);
  if (relayErrors.length > 0) throw new Error(`Maximum-file relay errors: ${relayErrors.join("; ")}`);

  process.stdout.write(
    `Maximum-file acceptance passed in system-chromium: exact 256 MiB source encrypted, uploaded as ${expectedEnvelopeBytes()} bytes, signed, published, resolved, downloaded, verified and decrypted back to the exact source in ${((Date.now() - startedAt) / 1000).toFixed(1)}s with a reported ${(heapLimit / MEBIBYTE).toFixed(0)} MiB JS heap limit; 256 MiB + 1 byte failed closed before recovery or upload authority. This is not operating-system memory-pressure proof.\n`,
  );
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await new Promise((resolve) => relay.close(() => resolve())).catch(() => undefined);
  await closeServer(relayHttp).catch(() => undefined);
  await closeServer(blossom).catch(() => undefined);
  await stopChild(production);
}
