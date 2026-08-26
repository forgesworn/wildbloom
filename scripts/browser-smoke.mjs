import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { platform } from "node:os";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { chromium } from "playwright-core";

const HOST = "127.0.0.1";
const PORT = 4173;
const ORIGIN = `http://${HOST}:${PORT}`;
const BLOSSOM = "https://cdn.example.com";
const BYTES = Buffer.from("hello wildbloom", "utf8");
const HASH = createHash("sha256").update(BYTES).digest("hex");
const SECRET = new Uint8Array(32).fill(11);
const PUBKEY = getPublicKey(SECRET);

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

async function waitForPreview(server) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite preview exited early with ${server.exitCode}.`);
    try {
      const response = await fetch(ORIGIN);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Vite preview.");
}

const preview = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", HOST, "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"],
});

let browser;
try {
  await waitForPreview(preview);
  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  const remoteRequests = [];
  let uploadAuthorisation;

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
    if (url.origin !== BLOSSOM || url.pathname !== "/upload") {
      await route.abort("blockedbyclient");
      return;
    }
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-SHA-256",
      "Access-Control-Allow-Methods": "PUT, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    if (request.method() !== "PUT") throw new Error(`Unexpected Blossom method: ${request.method()}`);
    const headers = request.headers();
    if (headers["x-sha-256"] !== HASH) throw new Error("Browser upload sent the wrong X-SHA-256.");
    if (!headers.authorization?.startsWith("Nostr ")) throw new Error("Browser upload omitted Blossom authorisation.");
    uploadAuthorisation = JSON.parse(Buffer.from(headers.authorization.slice(6), "base64url").toString("utf8"));
    await route.fulfill({
      status: 201,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `${BLOSSOM}/${HASH}.txt`,
        sha256: HASH,
        size: BYTES.length,
        type: "text/plain",
        uploaded: 1_700_000_000,
      }),
    });
  });

  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  if (remoteRequests.length !== 0) throw new Error(`Page made ambient remote requests: ${remoteRequests.join(", ")}`);

  await page.fill("#blossom-server", BLOSSOM);
  await page.fill("#tracker-urls", "wss://tracker.example.com/announce");
  await page.click("#connect-signer");
  await page.setInputFiles("#publish-file", { name: "hello.txt", mimeType: "text/plain", buffer: BYTES });
  await page.click("#inspect-file");
  await page.locator("#publish-status").filter({ hasText: "Local inspection complete" }).waitFor();
  if (!(await page.locator("#file-facts").textContent())?.includes(HASH)) throw new Error("Browser did not display the local SHA-256.");

  await page.check("#upload-consent");
  await page.click("#upload-file");
  await page.locator("#publish-status").filter({ hasText: "Hybrid metadata is staged" }).waitFor();
  const facts = await page.locator("#file-facts").textContent();
  if (!facts?.includes(`${BLOSSOM}/${HASH}.txt`) || !facts.includes("magnet:?")) {
    throw new Error("Browser did not stage Blossom and torrent metadata.");
  }
  if (!uploadAuthorisation) throw new Error("Browser did not send the signed Blossom authorisation.");
  const expectedTags = JSON.stringify([
    ["t", "upload"],
    ["server", "cdn.example.com"],
    ["x", HASH],
  ]);
  const scopedTags = uploadAuthorisation.tags.filter((tag) => ["t", "server", "x"].includes(tag[0]));
  if (JSON.stringify(scopedTags) !== expectedTags) throw new Error("Browser upload authorisation was not exactly scoped.");
  const expiration = Number(uploadAuthorisation.tags.find((tag) => tag[0] === "expiration")?.[1]);
  if (expiration - uploadAuthorisation.created_at !== 90) throw new Error("Browser upload authorisation lifetime changed.");

  await page.click("#sign-events");
  await page.locator("#publish-status").filter({ hasText: "Signed locally through NIP-07" }).waitFor();
  if (remoteRequests.filter((request) => request.startsWith("PUT ")).length !== 1) {
    throw new Error(`Expected one remote PUT, saw: ${remoteRequests.join(", ")}`);
  }
  if (pageErrors.length > 0) throw new Error(`Browser page errors: ${pageErrors.join("; ")}`);

  process.stdout.write("Browser smoke passed: no ambient network; local hash, scoped upload, torrent metadata and signing verified.\n");
} finally {
  if (browser) await browser.close();
  preview.kill("SIGTERM");
}
