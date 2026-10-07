import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import AxeBuilder from "@axe-core/playwright";
import {
  assertNoBrowserPersistence,
  installBrowserPersistenceAudit,
} from "./browser-persistence.mjs";
import { inspectProductionBuild } from "./production-build.mjs";

// Public synthetic keys stay in this harness, never enter application code.
const key = new Uint8Array(32).fill(42),
  pubkey = getPublicKey(key);
const binary = process.env.WILDBLOOM_NODE_BIN,
  fixture = process.env.WILDBLOOM_CHECKOUT_FIXTURE;
assert.ok(
  binary && fixture,
  "Set WILDBLOOM_NODE_BIN and WILDBLOOM_CHECKOUT_FIXTURE to reviewed executables.",
);
const build = inspectProductionBuild();
const root = mkdtempSync(join(tmpdir(), "wildbloom-services-"));
const children = new Set();
let browser, relay, activePage;
const faults = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function port() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function launch(cmd, args) {
  const c = spawn(cmd, args, { stdio: "ignore" });
  children.add(c);
  c.on("error", () => faults.push("Child failed to start"));
  return c;
}
async function stop(c) {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const done = once(c, "exit");
  c.kill("SIGTERM");
  const t = setTimeout(() => c.kill("SIGKILL"), 5000);
  try {
    await done;
  } finally {
    clearTimeout(t);
  }
}
async function ready(c, origin, path = "/") {
  for (let i = 0; i < 200; i++) {
    assert.equal(c.exitCode, null, "Service exited before readiness");
    try {
      if ((await fetch(origin + path, { signal: AbortSignal.timeout(500) })).ok)
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Service readiness timed out");
}
async function wait(page, text) {
  await page
    .locator("#node-service-status")
    .filter({ hasText: text })
    .waitFor();
}
async function sign(page, kind) {
  await page.waitForFunction((k) => {
    try {
      return (
        JSON.parse(document.querySelector("#external-unsigned-event").value)
          .kind === k
      );
    } catch {
      return false;
    }
  }, kind);
  const t = JSON.parse(await page.inputValue("#external-unsigned-event"));
  const e = finalizeEvent(t, key);
  await page.fill("#external-signed-event", JSON.stringify(e));
  await page.click("#accept-external-signature");
  return e;
}
async function action(page, id, kind = 27235) {
  await page.click(id);
  return sign(page, kind);
}
async function download(page, selector) {
  const promise = page.waitForEvent("download");
  await page.locator(selector).click();
  return readFileSync(await (await promise).path());
}
function uploadAuth(bytes, origin) {
  const now = Math.floor(Date.now() / 1000);
  return (
    "Nostr " +
    Buffer.from(
      JSON.stringify(
        finalizeEvent(
          {
            kind: 24242,
            created_at: now,
            content: "Synthetic acceptance upload",
            tags: [
              ["t", "upload"],
              ["x", hash(bytes)],
              ["server", new URL(origin).hostname],
              ["expiration", String(now + 60)],
            ],
          },
          key,
        ),
      ),
    ).toString("base64")
  );
}
try {
  const appOrigin = `http://127.0.0.1:${await port()}`,
    nodeOrigin = `http://127.0.0.1:${await port()}`,
    mintOrigin = `http://127.0.0.1:${await port()}`;
  const mint = launch(fixture, [new URL(mintOrigin).port]);
  await ready(mint, mintOrigin);
  const info = await (await fetch(mintOrigin)).json();
  const destination = {
    origin: mintOrigin + "/",
    addresses: [new URL(mintOrigin).host],
    allow_loopback_http: true,
  };
  const password = join(root, "password");
  writeFileSync(password, "synthetic-limited-password", { mode: 0o600 });
  const profile = join(root, "profile.json");
  writeFileSync(
    profile,
    JSON.stringify({
      checkout: {
        origin: nodeOrigin + "/",
        seller_id: "synthetic",
        seller_name: "Synthetic operator",
        network: "bitcoin",
        quote_seconds: 600,
        allow_loopback_http: true,
        tor_only: false,
        offers: [
          {
            id: "small",
            revision: 1,
            capacity_bytes: 1024 * 1024,
            duration_seconds: 3600,
            grace_seconds: 60,
            price_msat: 10000,
            delivery_bytes: 1024 * 1024,
            delivery_policy: "Synthetic operator-managed delivery",
            retention_policy: "One hour plus grace",
            refund_policy: "Contact synthetic operator",
          },
        ],
        issuers: [
          {
            id: "fixture",
            note_endpoint: mintOrigin + "/w",
            callback: mintOrigin + "/callback",
            mint_pubkey: info.mint_pubkey,
          },
        ],
      },
      state: join(root, "checkout"),
      browser_origins: [appOrigin],
      phoenixd: { destination, password_file: password },
      notes: [
        { endpoint: mintOrigin + "/w", destination },
        { endpoint: mintOrigin + "/callback", destination },
      ],
    }),
    { mode: 0o600 },
  );
  const args = [
    "--no-tor",
    "--bind",
    new URL(nodeOrigin).host,
    "--public-url",
    nodeOrigin,
    "--data-dir",
    join(root, "node"),
    "--repair-interval",
    "0",
    "--checkout-profile",
    profile,
    "--storage-proofs",
  ];
  let node = launch(binary, args);
  await ready(node, nodeOrigin);
  const unpaid = Buffer.from("unpaid synthetic upload");
  const denied = await fetch(nodeOrigin + "/upload", {
    method: "PUT",
    headers: {
      Authorization: uploadAuth(unpaid, nodeOrigin),
      "Content-Type": "application/octet-stream",
      "X-SHA-256": hash(unpaid),
    },
    body: unpaid,
  });
  assert.equal(denied.ok, false, "Unpaid signer has no upload authority");
  relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(relay, "listening");
  const relayUrl = `ws://127.0.0.1:${relay.address().port}/`;
  const list = finalizeEvent(
    {
      kind: 10063,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [["server", nodeOrigin + "/"]],
    },
    key,
  );
  const publications = [];
  relay.on("connection", (s) =>
    s.on("message", (b) => {
      const m = JSON.parse(b);
      if (m[0] === "REQ") {
        if (m[2].kinds?.includes(10063))
          s.send(JSON.stringify(["EVENT", m[1], list]));
        s.send(JSON.stringify(["EOSE", m[1]]));
      }
      if (m[0] === "EVENT") {
        assert.ok(verifyEvent(m[1]));
        publications.push(m[1]);
        s.send(JSON.stringify(["OK", m[1].id, true, "stored"]));
      }
    }),
  );
  const app = launch(process.execPath, [
    "scripts/serve-production.mjs",
    "--port",
    new URL(appOrigin).port,
  ]);
  await ready(app, appOrigin, "/healthz");
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.WILDBLOOM_BROWSER_EXECUTABLE ??
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/google-chrome"),
  });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(installBrowserPersistenceAudit);
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(20000);
  const requests = [];
  page.on("pageerror", (e) => faults.push(e.message));
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    requests.push(u.href);
    if (![appOrigin, nodeOrigin].includes(u.origin)) {
      faults.push("Unexpected browser origin");
      await route.abort();
    } else await route.continue();
  });
  await page.goto(appOrigin + "/#client");
  await page.locator("#connect-signer").waitFor();
  assert.ok(requests.every((u) => new URL(u).origin === appOrigin));
  await page.fill("#relay-urls", relayUrl);
  await page.fill("#blossom-server", nodeOrigin);
  await page.check('input[name="signing-method"][value="external"]');
  await page.fill("#external-signer-pubkey", pubkey);
  await page.click("#connect-signer");
  await page
    .locator('section[aria-labelledby="node-services-heading"] details')
    .evaluateAll((elements) => elements.forEach((e) => (e.open = true)));
  await page.fill("#discovery-keys", pubkey);
  const before = requests.filter((u) => u.startsWith(nodeOrigin)).length;
  await page.click("#discover-nodes");
  await wait(page, "Found 1 nodes");
  assert.equal(
    requests.filter((u) => u.startsWith(nodeOrigin)).length,
    before,
    "Discovery must not probe nodes",
  );
  await page.click("#discovery-results button");
  assert.equal(await page.inputValue("#blossom-server"), nodeOrigin + "/");
  await page.check("#list-public-consent");
  await action(page, "#publish-server-list", 10063);
  await wait(page, "Server list accepted");
  assert.equal(publications.length, 1);
  await page.click("#checkout-offers");
  await wait(page, "Offers loaded");
  await action(page, "#checkout-quote");
  await wait(page, "Quote reserved");
  const reference = JSON.parse(
    (await download(page, "#checkout-receipt-links a")).toString(),
  );
  await page.check("#checkout-consent");
  await action(page, "#checkout-pay");
  await wait(page, "awaiting_payment");
  assert.match(
    await page.locator("#checkout-payment a").getAttribute("href"),
    /^lightning:lnbc/u,
  );
  await action(page, "#checkout-check");
  await wait(page, "awaiting_payment");
  await fetch(mintOrigin + "/fixture/pay", { method: "POST" });
  await action(page, "#checkout-check");
  await wait(page, "active");
  assert.equal(
    (await (await fetch(mintOrigin)).json()).invoice_creations,
    1,
    "No replacement invoice on a check",
  );
  await stop(node);
  node = launch(binary, args);
  await ready(node, nodeOrigin);
  await page.reload();
  await page.locator("#connect-signer").waitFor();
  await page.fill("#blossom-server", nodeOrigin);
  await page.check('input[name="signing-method"][value="external"]');
  await page.fill("#external-signer-pubkey", pubkey);
  await page.click("#connect-signer");
  await page
    .locator('section[aria-labelledby="node-services-heading"] details')
    .evaluateAll((es) => es.forEach((e) => (e.open = true)));
  await page.fill("#checkout-reference", JSON.stringify(reference));
  await action(page, "#checkout-recover");
  await wait(page, "Recovered order: active");
  await page.setInputFiles("#publish-file", {
    name: "private-storage.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(65539, 73),
  });
  await page.click("#inspect-file");
  await page
    .locator("#publish-status")
    .filter({ hasText: "Encrypted transfer payload prepared" })
    .waitFor();
  await page.check("#key-saved-consent");
  await page.check("#upload-consent");
  await action(page, "#upload-file", 24242);
  await page
    .locator("#publish-status")
    .filter({ hasText: "Blossom metadata is staged" })
    .waitFor();
  await page.click("#sign-events");
  const fileEvent = await sign(page, 1063);
  await page
    .locator("#publish-status")
    .filter({ hasText: "Exact external signatures accepted" })
    .waitFor();
  await page
    .locator("#saved-event-json")
    .evaluate((e) => (e.closest("details").open = true));
  await page.fill("#saved-event-json", JSON.stringify(fileEvent));
  await page.click("#verify-saved-event");
  await page.check("#proof-consent");
  await action(page, "#storage-audit");
  await wait(page, "All selected targets passed");
  const audit = JSON.parse(
    (await download(page, "#storage-audit-results a")).toString(),
  );
  assert.equal(audit.proofs.length, 1);
  assert.equal(audit.failed.length, 0);
  const blobHash = fileEvent.tags.find((t) => t[0] === "x")[1];
  const blobPath = join(root, "node", "blobs", blobHash.slice(0, 2), blobHash);
  const original = readFileSync(blobPath);
  writeFileSync(blobPath, Buffer.alloc(original.length));
  await action(page, "#storage-audit");
  await wait(page, "Some targets could not be verified");
  writeFileSync(blobPath, original);
  await page.click("#checkout-offers");
  await wait(page, "Offers loaded");
  await page.selectOption("#checkout-rail", "lnurlcash");
  await page.fill("#checkout-renews", reference.order_id);
  await page.locator("#checkout-renews").dispatchEvent("change");
  await action(page, "#checkout-quote");
  await wait(page, "Quote reserved");
  await download(page, "#checkout-receipt-links a");
  await page.check("#checkout-consent");
  await page.fill("#checkout-note", mintOrigin + "/w?k1=" + "06".repeat(32));
  await action(page, "#checkout-pay");
  await wait(page, "active");
  assert.equal(await page.inputValue("#checkout-note"), "");
  assert.equal((await (await fetch(mintOrigin)).json()).note_rotations, 1);
  assert.equal(publications.length, 1, "No payment or proof events published");
  await assertNoBrowserPersistence(page, context, "Node services");
  const axe = await new AxeBuilder({ page })
    .include('section[aria-labelledby="node-services-heading"]')
    .analyze();
  assert.deepEqual(axe.violations, []);
  assert.deepEqual(faults, []);
  console.log(
    JSON.stringify(
      {
        version: 1,
        result: "passed",
        build,
        checks: [
          "explicit trusted discovery without node probes",
          "public list exact signing",
          "unpaid upload refused",
          "Lightning quote-invoice-check-activation",
          "one invoice across checks",
          "daemon restart and private order recovery",
          "paid encrypted upload",
          "fresh full-read proof",
          "corruption refusal",
          "LNURLcash exact-value rotation and activation",
          "no payment/proof relay publication",
          "no browser persistence",
          "service controls accessibility",
        ],
        limits:
          "Synthetic receiving backends, Chromium and one host; no real-money settlement or independent storage-custody proof.",
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (activePage)
    console.error(
      JSON.stringify({
        publish: await activePage.locator("#publish-status").textContent(),
        service: await activePage.locator("#node-service-status").textContent(),
      }),
    );
  throw error;
} finally {
  await browser?.close();
  for (const c of children) await stop(c);
  if (relay) await new Promise((r) => relay.close(r));
  rmSync(root, { recursive: true, force: true });
}
