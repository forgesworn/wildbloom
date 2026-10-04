import { fetchVerifiedBlob, inspectFile, uploadToBlossom, type BlossomRequestOptions } from "./blossom.js";
import { sha256Hex } from "./crypto.js";
import { codingBounds, decodeParts, encodeParts } from "./erasure.js";
import { assertSignedEventExactly, MAX_SIGNED_EVENT_JSON_BYTES, signEventExactly } from "./nostr.js";
import { assertHex64, assertPrototypeTransferSize, normaliseBlossomServer } from "./security.js";
import { WILDBLOOM_ENCRYPTION_V2, type EventTemplate, type NetworkProfile, type ResolvedHybridEvent, type SignedNostrEvent, type SignerPort } from "./types.js";

export interface PoolNode {
  id: string;
  origin: string;
  failure_group: string;
  weight: number;
}
export interface PoolPart { index: number; sha256: string; size: number; targets: PoolNode[] }
export interface PoolManifest {
  type: "wildbloom.pool";
  version: 1;
  mode: "replicas" | "erasure";
  profile: NetworkProfile;
  payload: { sha256: string; size: number; encryption: typeof WILDBLOOM_ENCRYPTION_V2 };
  required: number;
  total: number;
  copies: number;
  parts: PoolPart[];
}
export interface PoolReceipt { event: SignedNostrEvent; manifest: PoolManifest }
export interface PreparedPool { manifest: PoolManifest; files: File[] }
export interface PoolReport {
  verified: number[];
  protected: boolean;
  recoverable: boolean;
  observedAt: number;
}
type PoolOptions = BlossomRequestOptions & { progress?: (message: string) => void };
const ID = /^[a-z0-9_-]{1,40}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

function record(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) {
    throw new Error("Invalid pool schema or unsupported fields.");
  }
}

function validateNode(value: unknown, profile: NetworkProfile): asserts value is PoolNode {
  record(value, "id,origin,failure_group,weight");
  if (typeof value.id !== "string" || !ID.test(value.id)
    || typeof value.failure_group !== "string" || !ID.test(value.failure_group)
    || typeof value.origin !== "string" || value.origin.length > 256
    || value.origin !== `${normaliseBlossomServer(value.origin, profile)}/`
    || !Number.isInteger(value.weight) || Number(value.weight) < 1 || Number(value.weight) > 1000) {
    throw new Error("Invalid pool node, failure group, endpoint or weight.");
  }
}

export function parsePoolNodes(text: string, profile: NetworkProfile): PoolNode[] {
  if (text.length > 8192) throw new Error("Pool node list is too large.");
  const lines = text.trim().split(/\n/u).filter((line) => line.trim());
  const nodes = lines.map((line, index) => {
    const [origin, group, weight = "1", extra] = line.trim().split(/\s+/u);
    if (!origin || !group || extra !== undefined) throw new Error("Enter one origin, failure group and optional weight per line.");
    return { id: `node-${index + 1}`, origin: `${normaliseBlossomServer(origin, profile)}/`, failure_group: group, weight: Number(weight) };
  });
  validateNodes(nodes, profile);
  return nodes;
}

function validateNodes(nodes: PoolNode[], profile: NetworkProfile): void {
  if (nodes.length < 1 || nodes.length > 16) throw new Error("Configure 1–16 pool nodes.");
  nodes.forEach((node) => validateNode(node, profile));
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length || new Set(nodes.map((node) => node.origin)).size !== nodes.length) {
    throw new Error("Pool node IDs and origins must be unique.");
  }
  // Multiple ports at one hostname do not establish independent custody.
  // Explicit localhost development is allowed to exercise separate processes.
  const hosts = nodes.map((node) => {
    const url = new URL(node.origin);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url.origin : url.hostname;
  });
  if (new Set(hosts).size !== nodes.length) throw new Error("Use distinct node hostnames; ports do not establish independent nodes.");
}

export function validateManifest(value: unknown, profile: NetworkProfile): PoolManifest {
  record(value, "type,version,mode,profile,payload,required,total,copies,parts");
  if (value.type !== "wildbloom.pool" || value.version !== 1 || value.profile !== profile
    || !["replicas", "erasure"].includes(String(value.mode))) throw new Error("Unsupported pool mode, version or network profile.");
  record(value.payload, "sha256,size,encryption");
  if (typeof value.payload.sha256 !== "string" || !hashPattern.test(value.payload.sha256)
    || typeof value.payload.size !== "number" || value.payload.encryption !== WILDBLOOM_ENCRYPTION_V2) throw new Error("Invalid encrypted pool payload.");
  assertPrototypeTransferSize(value.payload.size);
  if (!Number.isInteger(value.copies) || Number(value.copies) < 1 || Number(value.copies) > 3) throw new Error("Choose 1–3 copies.");
  const required = Number(value.required), total = Number(value.total);
  if (typeof value.required !== "number" || typeof value.total !== "number") throw new Error("Invalid coding parameters.");
  if (value.mode === "erasure") {
    codingBounds(required, total);
    if (value.copies !== 1 || value.payload.size < required) throw new Error("Invalid erasure copy count or size.");
  } else if (required !== 1 || total !== 1 || Number(value.copies) < 2) throw new Error("Replicated storage needs two or three copies.");
  if (!Array.isArray(value.parts) || value.parts.length !== total) throw new Error("Wrong number of pool parts.");
  const allNodes: PoolNode[] = [];
  const assignedGroups = new Set<string>();
  for (let index = 0; index < total; index += 1) {
    const part: unknown = value.parts[index];
    record(part, "index,sha256,size,targets");
    if (part.index !== index || typeof part.sha256 !== "string" || !hashPattern.test(part.sha256)
      || part.size !== Math.ceil(value.payload.size / required) || !Array.isArray(part.targets)) throw new Error("Invalid part index, hash or size.");
    const nodes = part.targets as PoolNode[];
    validateNodes(nodes, profile);
    const groups = new Set(nodes.map((node) => node.failure_group));
    if (groups.size < Number(value.copies)) throw new Error("Not enough independent failure groups for the requested copies.");
    for (const group of groups) {
      if (assignedGroups.has(group)) throw new Error("Split parts must not share a failure group, including spare nodes.");
      assignedGroups.add(group);
    }
    allNodes.push(...nodes);
    if (value.mode === "replicas" && part.sha256 !== value.payload.sha256) throw new Error("Replica hash differs from payload.");
  }
  validateNodes(allNodes, profile);
  return value as unknown as PoolManifest;
}

export async function preparePool(
  encrypted: File, mode: PoolManifest["mode"], nodes: PoolNode[], required: number, total: number, copies: number,
  profile: NetworkProfile, signal?: AbortSignal,
): Promise<PreparedPool> {
  validateNodes(nodes, profile);
  assertPrototypeTransferSize(encrypted.size);
  if (new TextDecoder().decode(await encrypted.slice(0, 8).arrayBuffer()) !== "FSWNENC2") throw new Error("Pool storage requires a locally encrypted FSWNENC2 envelope.");
  if (mode === "erasure") { codingBounds(required, total); copies = 1; }
  else { required = 1; total = 1; }
  if (new Set(nodes.map((node) => node.failure_group)).size < total * copies) throw new Error("Add more independent failure groups before preparing this layout.");
  const payloadHash = await sha256Hex(encrypted, signal);
  // Stable weighted rendezvous order. Weight is an operator allocation, not a
  // claim about currently free space; the destination still enforces its quota.
  const ranked = await Promise.all(nodes.map(async (node) => {
    const digest = await sha256Hex(new Blob([`wildbloom.pool.v1\n${payloadHash}\n${node.origin}`]), signal);
    const uniform = (parseInt(digest.slice(0, 12), 16) + 1) / (2 ** 48 + 1);
    return { node, score: -Math.log(uniform) / node.weight };
  }));
  ranked.sort((a, b) => a.score - b.score || a.node.origin.localeCompare(b.node.origin));
  const groups = new Map<string, PoolNode[]>();
  for (const { node } of ranked) groups.set(node.failure_group, [...(groups.get(node.failure_group) ?? []), node]);
  const targets: PoolNode[][] = Array.from({ length: total }, () => []);
  [...groups.values()].forEach((group, i) => targets[i % total]!.push(...group));
  const blobs = mode === "erasure" ? await encodeParts(encrypted, required, total, signal) : [encrypted];
  const files = blobs.map((blob) => new File([blob], "part.bin", { type: "application/octet-stream" }));
  const parts = await Promise.all(files.map(async (file, index) => ({ index, sha256: await sha256Hex(file, signal), size: file.size, targets: targets[index]! })));
  const manifest = validateManifest({ type: "wildbloom.pool", version: 1, mode, profile,
    payload: { sha256: payloadHash, size: encrypted.size, encryption: WILDBLOOM_ENCRYPTION_V2 }, required, total, copies, parts }, profile);
  return { manifest, files };
}

export function poolTemplate(manifest: PoolManifest, now = Math.floor(Date.now() / 1000)): EventTemplate {
  validateManifest(manifest, manifest.profile);
  return { kind: 30078, created_at: now, tags: [["d", `wildbloom.pool.v1:${manifest.payload.sha256}`]], content: JSON.stringify(manifest) };
}

export function resolvePoolReceipt(json: string, profile: NetworkProfile, expectedId?: string): PoolReceipt {
  if (new TextEncoder().encode(json).length > MAX_SIGNED_EVENT_JSON_BYTES) throw new Error("Pool receipt exceeds 128 KiB.");
  const raw = JSON.parse(json) as SignedNostrEvent;
  const event = assertSignedEventExactly(raw, raw);
  if (event.kind !== 30078) throw new Error("Expected a signed pool receipt.");
  const manifest = validateManifest(JSON.parse(event.content), profile);
  if (JSON.stringify(event.tags) !== JSON.stringify(poolTemplate(manifest, event.created_at).tags)) throw new Error("Pool receipt has invalid binding tags.");
  if (expectedId && event.id !== assertHex64(expectedId, "Event ID")) throw new Error("Pool receipt does not match the expected event ID.");
  return { event, manifest };
}

export async function signPool(manifest: PoolManifest, signer: SignerPort, owner: string): Promise<PoolReceipt> {
  const event = await signEventExactly(poolTemplate(manifest), signer, owner);
  return resolvePoolReceipt(JSON.stringify(event), manifest.profile);
}

/** Add explicitly selected replacement endpoints without ever assigning an old
 * endpoint/failure group to a different coded part. Existing placement is kept
 * as history because an offline node might return holding its original part. */
export function extendPool(manifest: PoolManifest, replacements: string): PoolManifest {
  validateManifest(manifest, manifest.profile);
  if (replacements.length > 8192) throw new Error("Replacement node list is too large.");
  const next = structuredClone(manifest);
  const ids = new Set(next.parts.flatMap((part) => part.targets.map((node) => node.id)));
  for (const line of replacements.trim().split(/\n/u).filter((line) => line.trim())) {
    const [partNumber, origin, group, weight = "1", extra] = line.trim().split(/\s+/u);
    const index = Number(partNumber) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= next.total || !origin || !group || extra !== undefined) {
      throw new Error("Enter a part number (starting at 1), URL, failure group and optional weight per replacement.");
    }
    let id = "replacement-1";
    for (let i = 2; ids.has(id); i += 1) id = `replacement-${i}`;
    ids.add(id);
    next.parts[index]!.targets.push({ id, origin: `${normaliseBlossomServer(origin, manifest.profile)}/`, failure_group: group, weight: Number(weight) });
  }
  return validateManifest(next, manifest.profile);
}

function partEvent(receipt: PoolReceipt, part: PoolPart, node: PoolNode): ResolvedHybridEvent {
  return { event: receipt.event, url: `${node.origin}${part.sha256}`, sha256: part.sha256, size: part.size,
    mimeType: "application/octet-stream", name: "part.bin", trackers: [] };
}

function optionsFor(receipt: PoolReceipt, options: PoolOptions): PoolOptions {
  if (options.profile !== undefined && options.profile !== receipt.manifest.profile) throw new Error("Pool profile changed.");
  validateManifest(receipt.manifest, receipt.manifest.profile);
  if (JSON.stringify(resolvePoolReceipt(JSON.stringify(receipt.event), receipt.manifest.profile).manifest) !== JSON.stringify(receipt.manifest)) {
    throw new Error("Pool manifest differs from the signed receipt.");
  }
  // Include transfer and full read-back hashing time in the deadline. A fixed
  // 30 seconds makes the supported large-file layouts fail even on trusted
  // nodes. Budget at 256 KiB/s (128 KiB/s over Tor), with the existing 30-minute
  // Blossom operation ceiling; an explicit caller deadline still takes priority.
  const tor = receipt.manifest.profile === "tor";
  const transferMs = Math.ceil(receipt.manifest.parts[0]!.size / (tor ? 128 : 256) / 1024) * 1000;
  const timeoutMs = Math.min(30 * 60 * 1000, (tor ? 180_000 : 30_000) + transferMs);
  return { ...options, profile: receipt.manifest.profile, timeoutMs: options.timeoutMs ?? timeoutMs };
}

function report(receipt: PoolReceipt, verified: number[]): PoolReport {
  return { verified, protected: verified.every((count) => count >= receipt.manifest.copies),
    recoverable: verified.filter((count) => count > 0).length >= receipt.manifest.required, observedAt: Date.now() };
}

export async function uploadPool(prepared: PreparedPool, receipt: PoolReceipt, signer: SignerPort, owner: string, options: PoolOptions = {}): Promise<PoolReport> {
  const request = optionsFor(receipt, options);
  if (owner !== receipt.event.pubkey || JSON.stringify(prepared.manifest) !== JSON.stringify(receipt.manifest)
    || prepared.files.length !== receipt.manifest.total) throw new Error("Pool upload does not match its signed receipt.");
  // Validate ALL parts before any write; a malformed later part cannot leave a
  // partially accepted layout or silently change the authorised byte identity.
  const inspected = await Promise.all(prepared.files.map((file) => inspectFile(file, "transfer", request.signal)));
  if (inspected.some((file, i) => file.sha256 !== receipt.manifest.parts[i]!.sha256 || file.size !== receipt.manifest.parts[i]!.size)) throw new Error("Prepared pool bytes do not match the manifest.");
  const counts: number[] = [];
  for (const part of receipt.manifest.parts) {
    const groups = new Set<string>();
    for (const node of part.targets) {
      request.signal?.throwIfAborted();
      if (groups.has(node.failure_group)) continue;
      options.progress?.(`Part ${part.index + 1}/${receipt.manifest.total}: checking a configured node…`);
      try {
        await fetchVerifiedBlob(partEvent(receipt, part, node), request);
      } catch {
        request.signal?.throwIfAborted();
        try {
          await uploadToBlossom(inspected[part.index]!, node.origin, signer, owner, request);
          await fetchVerifiedBlob(partEvent(receipt, part, node), request);
        } catch {
          request.signal?.throwIfAborted();
          continue;
        }
      }
      groups.add(node.failure_group);
      if (groups.size >= receipt.manifest.copies) break;
    }
    counts.push(groups.size);
  }
  return report(receipt, counts);
}

export async function fetchPool(receipt: PoolReceipt, options: PoolOptions = {}): Promise<Blob> {
  const request = optionsFor(receipt, options);
  const available: Array<{ index: number; blob: Blob }> = [];
  for (const part of receipt.manifest.parts) {
    for (const node of part.targets) {
      request.signal?.throwIfAborted();
      options.progress?.(`Checking part ${part.index + 1}/${receipt.manifest.total}…`);
      try {
        const blob = await fetchVerifiedBlob(partEvent(receipt, part, node), request);
        available.push({ index: part.index, blob });
        break;
      } catch { request.signal?.throwIfAborted(); }
    }
    if (available.length >= receipt.manifest.required) break;
  }
  if (available.length < receipt.manifest.required) throw new Error(`Only ${available.length} verified parts remain; ${receipt.manifest.required} are needed. Recovery is unavailable.`);
  const payload = receipt.manifest.mode === "replicas" ? available[0]!.blob
    : await decodeParts(available, receipt.manifest.required, receipt.manifest.total, receipt.manifest.payload.size, request.signal);
  if (payload.size !== receipt.manifest.payload.size || await sha256Hex(payload, request.signal) !== receipt.manifest.payload.sha256) throw new Error("Reconstructed ciphertext failed verification.");
  return payload;
}

export async function preparePoolRepair(receipt: PoolReceipt, options: PoolOptions = {}): Promise<PreparedPool> {
  const payload = await fetchPool(receipt, options);
  const { manifest } = receipt;
  const parts = manifest.mode === "replicas" ? [payload] : await encodeParts(payload, manifest.required, manifest.total, options.signal);
  const files = parts.map((blob) => new File([blob], "part.bin", { type: "application/octet-stream" }));
  // uploadPool rechecks all regenerated hashes before any network write.
  return { manifest, files };
}
