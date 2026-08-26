import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { platform } from "node:os";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";

const HOST = "127.0.0.1";
const PORT = 4173;
const ORIGIN = `http://${HOST}:${PORT}`;
const BLOSSOM = "https://cdn.example.com";
const BYTES = Buffer.from("hello wildbloom", "utf8");
const SOURCE_HASH = createHash("sha256").update(BYTES).digest("hex");
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

function findChrome() {
  const candidates = platform() === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit browser path.
    }
  }
  throw new Error("Browser smoke requires an installed Chrome, Chromium or Brave executable.");
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
  await Promise.all([waitForServer(production), listen(relay)]);
  const relayAddress = relay.address();
  if (!relayAddress || typeof relayAddress === "string") throw new Error("Controlled relay did not expose a TCP port.");
  const relayUrl = `ws://${HOST}:${relayAddress.port}`;

  const headersResponse = await fetch(ORIGIN);
  const csp = headersResponse.headers.get("content-security-policy") ?? "";
  if (!csp.includes("frame-ancestors 'none'") || headersResponse.headers.get("x-frame-options") !== "DENY") {
    throw new Error("Production response security headers are missing.");
  }
  if (!headersResponse.headers.get("permissions-policy")?.includes("camera=()")) {
    throw new Error("Production response Permissions-Policy is missing.");
  }
  if ((await fetch(`${ORIGIN}/healthz`, { method: "POST" })).status !== 405) {
    throw new Error("Production server accepted a state-changing HTTP method.");
  }
  if ((await fetch(`${ORIGIN}/does-not-exist`)).status !== 404) {
    throw new Error("Production server did not return a genuine 404.");
  }

  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  const remoteRequests = [];
  const uploadAuthorisations = [];
  let uploadedBytes;
  let uploadedHash;

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
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === ORIGIN) {
      await route.continue();
      return;
    }
    remoteRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    const recognisedOrigin = url.origin === BLOSSOM || url.origin === ONION_BLOSSOM;
    if (!recognisedOrigin) {
      await route.abort("blockedbyclient");
      return;
    }
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-SHA-256",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    if (request.method() === "PUT" && url.pathname === "/upload") {
      const headers = request.headers();
      const body = request.postDataBuffer();
      if (!body) throw new Error("Browser upload omitted its request body.");
      if (body.includes(BYTES)) throw new Error("Browser upload exposed plaintext source bytes.");
      const hash = createHash("sha256").update(body).digest("hex");
      if (headers["x-sha-256"] !== hash) throw new Error("Browser upload sent the wrong X-SHA-256.");
      if (headers["content-type"] !== "application/vnd.wildbloom.encrypted") throw new Error("Browser upload exposed the source MIME type.");
      if (!headers.authorization?.startsWith("Nostr ")) throw new Error("Browser upload omitted Blossom authorisation.");
      uploadAuthorisations.push(JSON.parse(Buffer.from(headers.authorization.slice(6), "base64url").toString("utf8")));
      uploadedBytes = body;
      uploadedHash = hash;
      await route.fulfill({
        status: 201,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `${url.origin}/${hash}.wbenc`,
          sha256: hash,
          size: body.length,
          type: "application/vnd.wildbloom.encrypted",
          uploaded: 1_700_000_000,
        }),
      });
      return;
    }
    if (request.method() === "GET" && uploadedBytes && url.pathname === `/${uploadedHash}.wbenc`) {
      await route.fulfill({
        status: 200,
        headers: { ...cors, "Content-Type": "application/vnd.wildbloom.encrypted", "Content-Length": String(uploadedBytes.length) },
        body: uploadedBytes,
      });
      return;
    }
    await route.abort("blockedbyclient");
  });

  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  if (remoteRequests.length !== 0) throw new Error(`Page made ambient remote requests: ${remoteRequests.join(", ")}`);
  if (!(await page.locator("#upload-consent-copy").textContent())?.includes("encrypted bytes")) {
    throw new Error("The default encryption choice is not reflected in the upload authority copy.");
  }

  await page.fill("#blossom-server", BLOSSOM);
  await page.fill("#relay-urls", relayUrl);
  await page.fill("#tracker-urls", "wss://tracker.example.com/announce");
  await page.click("#connect-signer");
  await page.setInputFiles("#publish-file", { name: "hello.txt", mimeType: "text/plain", buffer: BYTES });
  await page.click("#inspect-file");
  await page.locator("#publish-status").filter({ hasText: "Encrypted transfer payload prepared" }).waitFor();
  const facts = await page.locator("#file-facts").textContent();
  if (!facts?.includes(SOURCE_HASH) || !facts.includes("wildbloom.wbenc") || facts.includes("Public payloadhello.txt")) {
    throw new Error("Browser did not separate private source facts from public encrypted metadata.");
  }
  const recoveryKey = await page.inputValue("#recovery-key-output");
  if (!/^wbk1_[A-Za-z0-9_-]{43}$/u.test(recoveryKey)) throw new Error("Browser did not generate a recovery key.");
  if (await page.getAttribute("#recovery-key-output", "type") !== "password") throw new Error("Recovery key was visible without a reveal action.");
  await page.click("#toggle-recovery-key");
  if (await page.getAttribute("#recovery-key-output", "type") !== "text") throw new Error("Recovery-key reveal action failed.");
  await page.click("#toggle-recovery-key");

  await page.check("#upload-consent");
  if (await page.isEnabled("#upload-file")) throw new Error("Upload enabled before recovery-key acknowledgement.");
  await page.check("#key-saved-consent");
  await page.click("#upload-file");
  await page.locator("#publish-status").filter({ hasText: "hybrid metadata is staged" }).waitFor();
  const stagedFacts = await page.locator("#file-facts").textContent();
  if (!stagedFacts?.includes("magnet:?")) throw new Error("Browser did not stage torrent metadata.");
  if (uploadAuthorisations.length !== 1 || !uploadedHash) throw new Error("Browser did not send one signed Blossom upload.");
  const directAuth = uploadAuthorisations[0];
  const scopedTags = directAuth.tags.filter((tag) => ["t", "server", "x"].includes(tag[0]));
  if (JSON.stringify(scopedTags) !== JSON.stringify([["t", "upload"], ["server", "cdn.example.com"], ["x", uploadedHash]])) {
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
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Save verified hello.txt" }).click();
  const download = await downloadPromise;
  if (download.suggestedFilename() !== "hello.txt") throw new Error("Decrypted download exposed the wrong filename.");
  const downloadedPath = await download.path();
  if (!downloadedPath || !readFileSync(downloadedPath).equals(BYTES)) throw new Error("Browser recovery did not reproduce the source bytes.");

  await page.check('input[name="network-profile"][value="tor"]');
  const trackerHidden = await page.isHidden("#tracker-field");
  const seedHidden = await page.isHidden("#seed-gate");
  if (!trackerHidden || !seedHidden) throw new Error(`Tor-only mode did not remove tracker and WebRTC controls (${trackerHidden}/${seedHidden}, profile=${await page.locator('input[name="network-profile"]:checked').getAttribute("value")}).`);
  await page.fill("#blossom-server", ONION_BLOSSOM);
  await page.check("#key-saved-consent");
  await page.check("#upload-consent");
  await page.click("#upload-file");
  await page.locator("#publish-status").filter({ hasText: "Confirm that the entire browser is configured through Tor" }).waitFor();
  if (uploadAuthorisations.length !== 1) throw new Error("Tor-only mode used the network before Tor confirmation.");

  await page.check("#tor-consent");
  await page.fill("#blossom-server", BLOSSOM);
  await page.click("#upload-file");
  await page.locator("#publish-status").filter({ hasText: "Tor-only mode" }).waitFor();
  if (uploadAuthorisations.length !== 1) throw new Error("Tor-only mode attempted a clearnet upload.");

  await page.fill("#blossom-server", ONION_BLOSSOM);
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
  if (pageErrors.length > 0) throw new Error(`Browser page errors: ${pageErrors.join("; ")}`);

  process.stdout.write("Browser acceptance passed: secure headers, no ambient network, encrypted upload/recovery, controlled relay round-trip, consent reset and fail-closed Tor-only transport verified.\n");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => relay.close(resolve));
  production.kill("SIGTERM");
}
