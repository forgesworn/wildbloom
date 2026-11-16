import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertNoBrowserPersistence } from "./browser-persistence.mjs";

/** Browser-only storage flow: the harness supplies an already checked ciphertext, never its key. */
export async function acceptExistingEnvelope({bytes, publisher, nodes, origin, allowed,
  pageAt, externalSigner, status, signUntil, hash}) {
  const p = publisher.page;
  p.setDefaultTimeout(60_000);
  await p.selectOption("#storage-mode", "erasure");
  await p.fill("#pool-nodes", nodes.map((node, i) => `${node.origin} site-${i} 1`).join("\n"));
  await p.check("#store-existing-envelope");
  await externalSigner(p);
  await p.setInputFiles("#publish-file", {name: "accounts.nstc", mimeType: "application/octet-stream", buffer: bytes});
  await p.click("#inspect-file");
  await status(p, "#publish-status", "Existing encrypted file prepared without another key");
  assert.equal(await p.inputValue("#recovery-key-output"), "");
  assert.equal(await p.locator("#key-saved-consent").isVisible(), false);
  await p.check("#upload-consent");
  await p.click("#upload-file");
  await signUntil(p, "#publish-status", "Requested layout verified");
  const saving = p.waitForEvent("download");
  await p.locator("#signed-event-links a").click();
  const receipt = readFileSync(await (await saving).path());
  const manifest = JSON.parse(JSON.parse(receipt.toString()).content);
  assert.equal(manifest.payload.sha256, hash(bytes));
  assert.equal(manifest.payload.size, bytes.length);
  assert.equal(manifest.required, 2); assert.equal(manifest.total, 4);
  await assertNoBrowserPersistence(p, publisher.context, "existing-envelope publisher");
  await publisher.context.close();
  let pairs = 0;
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    const surviving = new Set([a, b].map(i => new URL(manifest.parts[i].targets[0].origin).origin));
    const fresh = await pageAt(origin, allowed), r = fresh.page;
    r.setDefaultTimeout(60_000);
    try {
      await r.route("**/*", route => {
        const destination = new URL(route.request().url()).origin;
        return destination === origin || surviving.has(destination) ? route.continue() : route.abort();
      });
      await r.getByText("Use a saved file event or pool receipt", {exact: true}).click();
      await r.fill("#saved-event-json", receipt.toString());
      await r.click("#verify-saved-event");
      await status(r, "#retrieve-status", "Pool receipt verified locally");
      await r.check("#download-encrypted-pool");
      assert.equal(await r.locator("#recovery-key-input").isVisible(), false);
      await r.click("#fetch-blossom");
      await status(r, "#retrieve-status", "Pool parts and reconstructed ciphertext hash verified");
      const downloading = r.waitForEvent("download");
      await r.getByRole("link", {name: "Save verified encrypted file"}).click();
      assert.deepEqual(readFileSync(await (await downloading).path()), bytes);
      await assertNoBrowserPersistence(r, fresh.context, "existing-envelope recovery");
      pairs++;
    } finally { await fresh.context.close(); }
  }
  process.stdout.write(`Existing-envelope browser acceptance passed: ${bytes.length} exact bytes, no extra key, verified 2-of-4 upload, all ${pairs} pairs recovered in separate fresh browsers without the original signer, no relay/swarm/persistence. Local disposable nodes; physical custody is not established.\n`);
}
