import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { extendPool, fetchPool, parsePoolNodes, poolTemplate, preparePool, preparePoolRepair, resolvePoolReceipt, signPool, uploadPool, validateManifest, type PoolManifest } from "../src/core/pool.js";
import type { SignerPort } from "../src/core/types.js";
import { sha256Hex } from "../src/core/crypto.js";

const secret = new Uint8Array(32).fill(42);
const owner = getPublicKey(secret);
const signer: SignerPort = { getPublicKey: async () => owner, signEvent: async (template) => finalizeEvent(template, secret) };
const nodesText = Array.from({ length: 8 }, (_, i) => `https://n${i}.example group-${i} ${i + 1}`).join("\n");
const nodes = parsePoolNodes(nodesText, "direct");
const encrypted = new File(["FSWNENC2", new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 251))], "secret.wbenc");
async function fixture(mode: "replicas" | "erasure" = "erasure") {
  const prepared = await preparePool(encrypted, mode, nodes, 2, 4, 2, "direct");
  const receipt = await signPool(prepared.manifest, signer, owner);
  const storage = new Map<string, Blob>();
  const offline = new Set<string>();
  const corrupt = new Set<string>();
  const falseAck = new Set<string>();
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (offline.has(url.origin)) throw new Error("offline");
    if (init?.method === "PUT") {
      const bytes = init.body as File;
      const hash = await sha256Hex(bytes);
      const auth = JSON.parse(atob(new Headers(init.headers).get("Authorization")!.slice(6)));
      expect(auth.pubkey).toBe(owner);
      expect(auth.tags).toContainEqual(["x", hash]);
      expect(auth.tags).toContainEqual(["server", url.hostname]);
      const location = `${url.origin}/${hash}`;
      if (!falseAck.has(url.origin)) storage.set(location, bytes);
      return new Response(JSON.stringify({ url: location, sha256: hash, size: bytes.size, type: "application/octet-stream", uploaded: 123 }), { status: 201 });
    }
    const blob = storage.get(url.href);
    if (!blob) return new Response(null, { status: 404 });
    return new Response(corrupt.has(url.origin) ? new Uint8Array(blob.size) : blob, { headers: { "Content-Length": String(blob.size) } });
  });
  return { prepared, receipt, storage, offline, corrupt, falseAck, fetchMock, options: { profile: "direct" as const, fetchImpl: fetchMock, progress: vi.fn() } };
}

describe("private pool receipts, placement and recovery", () => {
  it("allows large-part transfers beyond thirty seconds while honouring an explicit deadline", async () => {
    const f = await fixture();
    const large = structuredClone(f.receipt.manifest);
    large.payload.size = 256 * 1024 * 1024;
    for (const part of large.parts) part.size = large.payload.size / large.required;
    const receipt = await signPool(large, signer, owner);
    vi.useFakeTimers();
    try {
      let aborted = 0;
      const delayed = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((resolve, reject) => {
        const signal = init!.signal!;
        const cancel = (): void => { aborted += 1; clearTimeout(timer); reject(new Error("deadline")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(new Response(null, { status: 404 })); }, 31_000);
        signal.addEventListener("abort", cancel, { once: true });
      }));
      const normal = fetchPool(receipt, { fetchImpl: delayed }).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await normal).toBeInstanceOf(Error);
      expect(aborted).toBe(0);
      expect(delayed).toHaveBeenCalledTimes(8);
      const bounded = fetchPool(receipt, { fetchImpl: delayed, timeoutMs: 10 }).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await bounded).toBeInstanceOf(Error);
      expect(aborted).toBe(8);
    } finally { vi.useRealTimers(); }
  });

  it("adds signed replacement nodes while preserving all historical assignments", async () => {
    const f = await fixture();
    const next = extendPool(f.receipt.manifest, "1 https://replacement.example new-site 2\n2 https://replacement2.example another-site");
    expect(next.parts[0]!.targets).toHaveLength(3);
    expect(next.parts[0]!.targets.slice(0, 2)).toEqual(f.receipt.manifest.parts[0]!.targets);
    expect(next.parts[1]!.targets[2]!.id).toBe("replacement-2");
    expect(f.receipt.manifest.parts[0]!.targets).toHaveLength(2);
    await expect(fetchPool({ ...f.receipt, manifest: next }, f.options)).rejects.toThrow(/signed receipt/u);
    for (const text of ["0 https://replacement.example new-site", "1 https://replacement.example", "x".repeat(8193),
      `1 ${f.receipt.manifest.parts[1]!.targets[0]!.origin} new-site`,
      `1 https://replacement.example ${f.receipt.manifest.parts[1]!.targets[0]!.failure_group}`]) {
      expect(() => extendPool(f.receipt.manifest, text)).toThrow();
    }
    expect(extendPool(next, "")).toEqual(next);
  });
  it("spreads coded parts across disjoint groups and preserves assignments under node-list reordering", async () => {
    const f = await fixture();
    const reordered = await preparePool(encrypted, "erasure", [...nodes].reverse(), 2, 4, 1, "direct");
    expect(reordered.manifest).toEqual(f.prepared.manifest);
    expect(f.receipt.manifest.parts.flatMap((part) => part.targets).length).toBe(8);
    expect(f.receipt.event.content).not.toContain("secret.wbenc");
    const template = poolTemplate(f.receipt.manifest);
    expect(template.tags).toEqual([["d", `wildbloom.pool.v1:${await sha256Hex(encrypted)}`]]);
  });

  it("stores only parts, recovers after losing every data part, and repairs from parity to spare nodes", async () => {
    const f = await fixture();
    const uploaded = await uploadPool(f.prepared, f.receipt, signer, owner, f.options);
    expect(uploaded.protected).toBe(true);
    expect(f.storage.size).toBe(4);
    expect([...f.storage.values()].every((blob) => blob.size < encrypted.size)).toBe(true);
    for (const part of f.receipt.manifest.parts.slice(0, 2)) f.offline.add(new URL(part.targets[0]!.origin).origin);
    const recovered = await fetchPool(f.receipt, f.options);
    expect(await sha256Hex(recovered)).toBe(await sha256Hex(encrypted));
    const repair = await preparePoolRepair(f.receipt, f.options);
    const repaired = await uploadPool(repair, f.receipt, signer, owner, f.options);
    expect(repaired.protected).toBe(true);
    expect(f.storage.size).toBe(6);
    // Every URL written is an authorised part on that part's assigned nodes.
    for (const [url, blob] of f.storage) expect(f.receipt.manifest.parts.some((part) => part.targets.some((node) => url === `${node.origin}${part.sha256}`) && blob.size === part.size)).toBe(true);
  });

  it("rejects too few survivors and ignores corrupt bytes and false acknowledgements", async () => {
    const f = await fixture();
    f.receipt.manifest.parts[0]!.targets.forEach((node) => f.falseAck.add(new URL(node.origin).origin));
    const result = await uploadPool(f.prepared, f.receipt, signer, owner, f.options);
    expect(result.protected).toBe(false);
    expect(result.recoverable).toBe(true);
    f.receipt.manifest.parts[1]!.targets.forEach((node) => f.corrupt.add(new URL(node.origin).origin));
    f.receipt.manifest.parts[2]!.targets.forEach((node) => f.offline.add(new URL(node.origin).origin));
    await expect(fetchPool(f.receipt, f.options)).rejects.toThrow(/Only 1 verified parts/u);
  });

  it("maintains full replicas, falls back on read, and keeps authorisation in the external signer", async () => {
    const f = await fixture("replicas");
    expect((await uploadPool(f.prepared, f.receipt, signer, owner, f.options)).verified).toEqual([2]);
    const first = f.receipt.manifest.parts[0]!.targets[0]!;
    f.offline.add(new URL(first.origin).origin);
    expect(await sha256Hex(await fetchPool(f.receipt, f.options))).toBe(await sha256Hex(encrypted));
    const repaired = await uploadPool(await preparePoolRepair(f.receipt, f.options), f.receipt, signer, owner, f.options);
    expect(repaired.protected).toBe(true);
  });

  it("refuses mismatched bytes and owner, and cancels without further writes", async () => {
    const f = await fixture();
    const bad = { ...f.prepared, files: f.prepared.files.map(() => encrypted) };
    await expect(uploadPool(bad, f.receipt, signer, owner, f.options)).rejects.toThrow(/bytes/u);
    await expect(uploadPool(f.prepared, f.receipt, signer, "a".repeat(64), f.options)).rejects.toThrow(/receipt/u);
    expect(f.fetchMock).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(fetchPool(f.receipt, { ...f.options, signal: controller.signal })).rejects.toThrow();
    await expect(uploadPool(f.prepared, f.receipt, signer, owner, { ...f.options, signal: controller.signal })).rejects.toThrow();
    expect(f.fetchMock).not.toHaveBeenCalled();
    await expect(fetchPool(f.receipt, { ...f.options, profile: "tor" })).rejects.toThrow(/profile/u);
  });

  it("verifies event ID, signature, schema, parameters, group separation and profile before fetching", async () => {
    const f = await fixture();
    const json = JSON.stringify(f.receipt.event);
    expect(resolvePoolReceipt(json, "direct", f.receipt.event.id)).toEqual(f.receipt);
    expect(() => resolvePoolReceipt(json, "direct", "f".repeat(64))).toThrow();
    expect(() => resolvePoolReceipt(json, "tor")).toThrow();
    expect(() => resolvePoolReceipt(" ".repeat(131073), "direct")).toThrow();
    expect(() => resolvePoolReceipt(JSON.stringify({ ...f.receipt.event, sig: "0".repeat(128) }), "direct")).toThrow();
    const mutations: Array<(m: PoolManifest) => void> = [
      (m) => { m.version = 2 as 1; }, (m) => { m.copies = 4; }, (m) => { m.required = 1; },
      (m) => { m.required = "2" as unknown as number; }, (m) => { m.parts.pop(); },
      (m) => { m.parts[0]!.size++; }, (m) => { m.parts[0]!.sha256 = "a"; },
      (m) => { m.parts[0]!.index = 9; }, (m) => { m.payload.encryption = "wrong" as typeof m.payload.encryption; },
      (m) => { m.parts[0]!.targets[0]!.failure_group = m.parts[1]!.targets[0]!.failure_group; },
      (m) => { m.parts[0]!.targets[0]!.origin = "https://unapproved.example/path"; },
      (m) => { Object.assign(m, { secret: "never" }); },
    ];
    for (const mutate of mutations) {
      const manifest = structuredClone(f.receipt.manifest); mutate(manifest);
      expect(() => validateManifest(manifest, "direct")).toThrow();
    }
    const wrongTags = finalizeEvent({ ...poolTemplate(f.receipt.manifest), tags: [] }, secret);
    expect(() => resolvePoolReceipt(JSON.stringify(wrongTags), "direct")).toThrow(/tags/u);
    const wrongKind = finalizeEvent({ ...poolTemplate(f.receipt.manifest), kind: 1 }, secret);
    expect(() => resolvePoolReceipt(JSON.stringify(wrongKind), "direct")).toThrow();
  });

  it("validates node configuration before coding and rejects plaintext or undersized pools", async () => {
    for (const text of ["", "x".repeat(8193), "https://a.example", "https://a.example g 1 extra", "https://a.example g 0", "https://a.example g 1\nhttps://a.example g2 1", "https://a.example g 1\nhttps://a.example:8443 g2 1"]) {
      expect(() => parsePoolNodes(text, "direct")).toThrow();
    }
    await expect(preparePool(new File(["plaintext"], "file.txt"), "replicas", nodes, 1, 1, 2, "direct")).rejects.toThrow(/encrypted/u);
    await expect(preparePool(encrypted, "erasure", nodes.slice(0, 2), 2, 4, 1, "direct")).rejects.toThrow(/groups/u);
    const f = await fixture("replicas");
    f.receipt.manifest.parts[0]!.sha256 = "a".repeat(64);
    expect(() => validateManifest(f.receipt.manifest, "direct")).toThrow(/hash/u);
  });
});
