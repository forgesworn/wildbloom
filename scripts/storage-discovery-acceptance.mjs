// Production browser UI against a synthetic relay and intercepted HTTP fixtures.
// Native two-node admission is tested separately; no live operator or money here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { once } from "node:events";
import { chromium, firefox, webkit } from "playwright-core";
import { WebSocketServer } from "ws";
import { finalizeEvent } from "nostr-tools/pure";
import { buildStorageAnnouncement } from "402-announce/storage";
import AxeBuilder from "@axe-core/playwright";
import { installBrowserPersistenceAudit, assertNoBrowserPersistence } from "./browser-persistence.mjs";

function chrome() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : process.platform === "win32"
      ? [process.env.PROGRAMFILES,process.env["PROGRAMFILES(X86)"],process.env.LOCALAPPDATA].filter(Boolean).map(p => join(p,"Google","Chrome","Application","chrome.exe"))
      : ["/usr/bin/google-chrome","/usr/bin/google-chrome-stable","/usr/bin/chromium","/usr/bin/chromium-browser"];
  for (const path of candidates) { try { accessSync(path,constants.X_OK); return path; } catch {} }
  throw Error("Storage discovery acceptance requires an installed Chrome executable.");
}
async function port() {
  const s = createServer(); s.listen(0,"127.0.0.1"); await once(s,"listening");
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}
const selectedBrowser = process.argv.includes("--browser") ? process.argv[process.argv.indexOf("--browser")+1] : "system-chromium";
const engine = {"system-chromium":chromium,chromium,firefox,webkit}[selectedBrowser];
assert.ok(engine,"Unknown acceptance browser.");
const appPort = await port();
const server = spawn(process.execPath,["scripts/serve-production.mjs","--port",String(appPort)],{stdio:"ignore"});
let browser, context, relay;
try {
  for (let n = 0; n < 100; n++) {
    assert.equal(server.exitCode,null,"Production server exited before readiness.");
    try { if ((await fetch(`http://127.0.0.1:${appPort}/`,{signal:AbortSignal.timeout(500)})).ok) break; } catch {}
    await new Promise(r => setTimeout(r,50));
  }
  relay = new WebSocketServer({host:"127.0.0.1",port:0}); await once(relay,"listening");
  const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
  const base = JSON.parse(readFileSync("node_modules/402-announce/fixtures/storage-v1/combined.json","utf8")).description;
  const at = Math.floor(Date.now()/1000)-5;
  let listing = {...base,observed_at:at,expires_at:at+7200,name:"Synthetic <img src=x onerror=alert(1)> storage"};
  let description = structuredClone(listing);
  let advertised = [finalizeEvent(buildStorageAnnouncement(listing),new Uint8Array(32).fill(1))];
  let relayQueries = 0, requests = [], sockets = 0;
  const faults = [];
  relay.on("connection",socket => {
    sockets++;
    socket.on("message",bytes => {
      const message = JSON.parse(bytes.toString());
      if (message[0] !== "REQ") return;
      relayQueries++;
      assert.deepEqual(message[2],{kinds:[31402],"#t":["forgesworn-storage-service-v1"],limit:64});
      for (const event of advertised) socket.send(JSON.stringify(["EVENT",message[1],event]));
      socket.send(JSON.stringify(["EOSE",message[1]]));
    });
  });
  browser = await engine.launch({headless:true,...(selectedBrowser === "system-chromium" ? {executablePath:chrome()} : {})});
  context = await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(installBrowserPersistenceAudit);
  const page = await context.newPage();
  page.on("pageerror",error => faults.push(error.message));
  await page.route("https://storage.example/**",async route => {
    const request = route.request(); requests.push({url:request.url(),method:request.method(),headers:request.headers()});
    let value;
    if (request.url().endsWith("/services/v1")) value = description;
    else if (request.url().endsWith("/checkout/v1/offers")) {
      const c = description.checkout;
      value = {version:1,seller_id:"synthetic",seller_name:description.name,node_origin:c.origin,network:c.network,rails:c.rails,issuers:c.issuers,features:[],
        offers:description.services.filter(s => s.type === "paid-storage").map(s => { const {type,availability,...offer} = s; return offer; })};
    } else throw Error("Unexpected operator request.");
    await route.fulfill({status:200,contentType:"application/json",headers:{"access-control-allow-origin":`http://127.0.0.1:${appPort}`},body:JSON.stringify(value)});
  });
  await page.goto(`http://127.0.0.1:${appPort}/#client-services`,{waitUntil:"networkidle"});
  assert.equal(requests.length,0,"Page load contacted a storage node."); assert.equal(sockets,0,"Page load opened a relay.");
  await page.fill("#relay-urls",relayUrl);
  const details = page.locator("#client-services details").filter({has:page.locator("#discover-storage-services")});
  await details.locator("summary").click();
  async function wait(text) { await page.locator("#node-service-status").filter({hasText:text}).waitFor(); }
  async function find() { await page.click("#discover-storage-services"); await wait("service listings for this network profile"); }
  async function choose() { await page.locator("#storage-service-results button").first().click(); await wait("Service selected"); }
  await find(); assert.equal(relayQueries,1); assert.equal(requests.length,0);
  assert.ok((await page.locator("#storage-service-results").textContent()).includes("<img src=x onerror=alert(1)>"));
  assert.equal(await page.locator("#storage-service-results img").count(),0,"Remote text became HTML.");
  await choose(); assert.equal(requests.length,0,"Selection probed the node.");
  await page.click("#inspect-storage-service"); await wait("Current service identity and terms checked");
  assert.equal(requests.length,1); assert.equal(requests[0].method,"GET");
  assert.equal(requests[0].headers.authorization,undefined); assert.equal(requests[0].headers.cookie,undefined);
  assert.ok((await page.locator("#storage-service-description").textContent()).includes("direct unknown uploads are refused"));
  await page.click("#use-storage-service"); await wait("Paid node selected"); assert.equal(requests.length,1);
  assert.equal(await page.inputValue("#blossom-server"),"https://storage.example/");
  const checkout = page.locator("#client-services details").filter({has:page.locator("#checkout-offers")});
  await checkout.locator("summary").click(); await page.click("#checkout-offers"); await wait("Offers loaded");
  assert.equal(requests.length,2); assert.equal(await page.locator("#checkout-plan option").count(),1);
  await page.check("#checkout-consent");
  // An explicit refresh sees a new price; stale quote/payment consent is cleared.
  description.services = description.services.map(s => s.type === "paid-storage" ? {...s,price_msat:s.price_msat+1000,revision:s.revision+1} : s);
  await page.click("#checkout-offers"); await wait("terms changed"); assert.equal(await page.isChecked("#checkout-consent"),false);
  assert.equal(await page.locator("#checkout-plan option").count(),0);
  await page.click("#inspect-storage-service"); await wait("Current service identity and terms checked");
  await page.click("#checkout-offers"); await wait("Offers loaded");
  // Identity mismatch cannot leave usable terms or a consented payment behind.
  const properKey = description.service_pubkey; description.service_pubkey = "0".repeat(64);
  await page.click("#inspect-storage-service"); await wait("Invalid storage service profile");
  assert.equal(await page.locator("#storage-service-description").textContent(),"");
  assert.equal(await page.isChecked("#checkout-consent"),false); description.service_pubkey = properKey;
  // Withdrawal is selected before filtering. Omission of it on the next lookup cannot resurrect older paid terms.
  const previous = advertised[0];
  const withdrawn = {...listing,observed_at:at+1,expires_at:at+7201,state:"withdrawn",services:listing.services.map(s => ({...s,availability:"paused"}))};
  advertised = [previous,finalizeEvent(buildStorageAnnouncement(withdrawn),new Uint8Array(32).fill(1))];
  await find(); assert.equal(await page.locator("#storage-service-results button:enabled").count(),0);
  advertised = [previous]; await find(); assert.equal(await page.locator("#storage-service-results button:enabled").count(),0);
  assert.ok((await page.locator("#storage-service-results").textContent()).includes("withdrawn"));
  const axe = await new AxeBuilder({page}).include("#client-services").analyze();
  assert.deepEqual(axe.violations,[],"Storage service controls introduced an accessibility violation.");
  await page.setViewportSize({width:360,height:780});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1),"Service metadata overflowed the narrow viewport.");
  await assertNoBrowserPersistence(page,context,"public service discovery");
  assert.deepEqual(faults,[]);
  console.log(`Storage discovery acceptance passed (${selectedBrowser}): no load/selection probes; bound terms; changed-price consent reset; identity rejection; withdrawal watermark; plain text; accessibility; no persistence.`);
} finally {
  await context?.close(); await browser?.close();
  if (relay) { for (const client of relay.clients) client.terminate(); await new Promise(r => relay.close(r)); }
  if (server.exitCode === null && server.signalCode === null) { const done = once(server,"exit"); server.kill("SIGTERM"); await done; }
}
