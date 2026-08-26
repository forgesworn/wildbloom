import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { createServer } from "node:http";
import { platform } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const HOST = "127.0.0.1";
const MEBIBYTE = 1024 * 1024;
const MAXIMUM_SOURCE_BYTES = 256 * MEBIBYTE;
const V8_HEAP_CAP_MIB = 256;

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

const port = await availablePort();
const origin = `http://${HOST}:${port}`;
let production;
let browser;
try {
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
  const undeclaredRequests = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) await route.continue();
    else {
      undeclaredRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
    }
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  const heapLimit = await page.evaluate(() => performance.memory?.jsHeapSizeLimit ?? 0);
  if (heapLimit === 0 || heapLimit > 384 * MEBIBYTE) {
    throw new Error(`Chrome did not apply the intended constrained JS heap (${heapLimit} bytes reported).`);
  }

  await selectGeneratedFile(page, MAXIMUM_SOURCE_BYTES, "maximum.bin");
  const startedAt = Date.now();
  await page.click("#inspect-file");
  await page.locator("#publish-status").filter({ hasText: "Encrypted transfer payload prepared" }).waitFor({ timeout: 5 * 60 * 1000 });
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
  if (facts["Source SHA-256"] !== sourceHash()) throw new Error("Maximum source bytes produced the wrong SHA-256.");
  if (facts["Public bytes"] !== String(expectedEnvelopeBytes())) throw new Error("Maximum encrypted envelope had an unexpected size.");
  if (facts["Public payload"] !== "wildbloom.wbenc") throw new Error("Maximum source metadata leaked into the public payload name.");
  if (!/^wbk1_[A-Za-z0-9_-]{43}$/u.test(await page.inputValue("#recovery-key-output"))) {
    throw new Error("Maximum encryption did not produce a recovery key.");
  }

  await selectGeneratedFile(page, MAXIMUM_SOURCE_BYTES + 1, "too-large.bin");
  await page.click("#inspect-file");
  await page.locator("#publish-status.error").filter({ hasText: "limited to 256 MiB" }).waitFor({ timeout: 10_000 });
  if (!(await page.isHidden("#recovery-key-panel")) || await page.isEnabled("#upload-file")) {
    throw new Error("Oversized rejection retained recovery material or upload authority.");
  }
  if (pageErrors.length > 0) throw new Error(`Maximum-file page errors: ${pageErrors.join("; ")}`);
  if (undeclaredRequests.length > 0) throw new Error(`Maximum-file page made undeclared requests: ${undeclaredRequests.join("; ")}`);

  process.stdout.write(
    `Maximum-file acceptance passed in system-chromium: exact 256 MiB source encrypted into ${expectedEnvelopeBytes()} bytes in ${((Date.now() - startedAt) / 1000).toFixed(1)}s with a reported ${(heapLimit / MEBIBYTE).toFixed(0)} MiB JS heap limit; 256 MiB + 1 byte failed closed before recovery or upload authority. This is not operating-system memory-pressure proof.\n`,
  );
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopChild(production);
}
