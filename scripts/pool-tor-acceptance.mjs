// Optional real-Tor extension of the browser/native acceptance. Test services
// and all onion identities are ephemeral; this never touches installed nodes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeEvent } from "nostr-tools/pure";

export async function acceptPoolTor({ root, binary, manifest, selected, owner, secret, signerPath, port, launch, stop, ready, native, children, hash }) {
  const tor = process.env.WILDBLOOM_TEST_TOR_BIN;
  if (!tor) throw new Error("--tor requires WILDBLOOM_TEST_TOR_BIN");
  const data = join(root, "pool-tor"); mkdirSync(data, { mode: 0o700 });
  const socksPort = await port();
  const lines = [`DataDirectory ${JSON.stringify(data)}`, `SocksPort 127.0.0.1:${socksPort}`, "Log notice stdout", "ClientOnly 1", "AvoidDiskWrites 1"];
  const services = selected.map((node, i) => {
    const dir = join(root, `pool-onion-${i}`); mkdirSync(dir, { mode: 0o700 });
    lines.push(`HiddenServiceDir ${JSON.stringify(dir)}`, "HiddenServiceVersion 3", `HiddenServicePort 80 ${new URL(node.origin).host}`);
    return dir;
  });
  const config = join(root, "pool-torrc"); writeFileSync(config, lines.join("\n"), { mode: 0o600 });
  const torChild = spawn(tor, ["-f", config], { stdio: ["ignore", "pipe", "ignore"] }); children.push(torChild);
  let bootstrap = false;
  torChild.stdout.on("data", (data) => { if (data.toString().includes("Bootstrapped 100%")) bootstrap = true; });
  const deadline = Date.now() + 240000;
  while (!bootstrap) {
    assert.equal(torChild.exitCode, null, "Ephemeral Tor exited before bootstrap");
    if (Date.now() > deadline) throw new Error("Ephemeral Tor did not bootstrap in four minutes");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const onions = services.map((dir) => readFileSync(join(dir, "hostname"), "utf8").trim());
  // Keep the two parity disks. Both data disks start empty: all repair traffic
  // must traverse real onion services before the owner can restore them.
  for (let i = 0; i < selected.length; i++) {
    const node = selected[i]; await stop(node.child);
    const directory = i < 2 ? join(root, `tor-empty-${i}`) : join(root, `empty-parity-${i - 2}`);
    node.child = launch(binary, ["--no-tor", "--bind", new URL(node.origin).host, "--public-url", node.origin,
      "--server-name", onions[i], "--allow-pubkey", owner, "--data-dir", directory, "--repair-interval", "0"]);
    await ready(node.child, node.origin);
  }
  // A separate synthetic transport receipt; this is not a production migration.
  const torManifest = structuredClone(manifest); torManifest.profile = "tor";
  for (let i = 0; i < 4; i++) torManifest.parts[i].targets = [{ id: `tor-${i}`, origin: `http://${onions[i]}/`, failure_group: `tor-site-${i}`, weight: 1 }];
  const receipt = finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now()/1000),
    tags: [["d", `wildbloom.pool.v1:${manifest.payload.sha256}`]], content: JSON.stringify(torManifest) }, secret);
  const receiptPath = join(root, "tor-receipt.json"); writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const args = ["replicas", "pool-repair", "--receipt", receiptPath, "--receipt-id", receipt.id, "--owner", owner,
    "--work-dir", join(root, "tor-owner-work"), "--allow-reconstruction", "--expires-at", String(Math.floor(Date.now()/1000)+900),
    "--signer", process.execPath, `--signer-arg=${signerPath}`, "--once"];
  const absent = await native(args);
  assert.notEqual(absent.code, 0); assert.equal(absent.stdout, "", "Tor profile must refuse to run without an explicit proxy");
  let result;
  // Newly published onion descriptors may need time to become reachable.
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await native([...args, "--proxy", `socks5h://127.0.0.1:${socksPort}`], 600000);
    if (result.code === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).protected, true);
  for (let i = 0; i < 4; i++) {
    const part = manifest.parts[i];
    const response = await fetch(`${selected[i].origin}/${part.sha256}`);
    assert.equal(response.status, 200); assert.equal(hash(Buffer.from(await response.arrayBuffer())), part.sha256);
    assert.equal((await fetch(`${selected[i].origin}/${manifest.payload.sha256}`)).status, 404);
  }
  await stop(torChild);
  process.stdout.write("Real-Tor owner pool repair passed: four ephemeral onion services, parity-only native reconstruction, verified restored parts and refusal without an explicit SOCKS proxy. This is not branded Tor Browser or independent physical custody evidence.\n");
}
