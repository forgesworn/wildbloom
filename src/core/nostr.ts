import { validateEvent, verifyEvent } from "nostr-tools";
import type {
  BlobDescriptor,
  EventTemplate,
  HybridPublication,
  ResolvedHybridEvent,
  SignedNostrEvent,
  SignerPort,
  TorrentPlan,
} from "./types.js";
import {
  assertHex40,
  assertHex64,
  assertPrototypeFileSize,
  normaliseBlossomServer,
  normaliseBlossomUrl,
  sanitiseFileName,
} from "./security.js";

const AUTH_KIND = 24242;
const FILE_KIND = 1063;
const TORRENT_KIND = 2003;

function exactTag(template: EventTemplate, name: string, value: string): boolean {
  return template.tags.some((tag) => tag.length === 2 && tag[0] === name && tag[1] === value);
}

function uniqueTag(tags: readonly string[][], name: string): string {
  const values = tags.filter((tag) => tag[0] === name && typeof tag[1] === "string").map((tag) => tag[1] as string);
  if (values.length !== 1) throw new Error(`Signed event must contain exactly one ${name} tag.`);
  return values[0] as string;
}

function eventsMatch(template: EventTemplate, signed: SignedNostrEvent): boolean {
  return signed.kind === template.kind
    && signed.created_at === template.created_at
    && signed.content === template.content
    && JSON.stringify(signed.tags) === JSON.stringify(template.tags);
}

export async function signEventExactly(
  template: EventTemplate,
  signer: SignerPort,
  expectedPubkey: string,
): Promise<SignedNostrEvent> {
  const pubkey = assertHex64(expectedPubkey, "Signer public key");
  const signed = await signer.signEvent(structuredClone(template));
  if (!eventsMatch(template, signed)) throw new Error("The signer changed the event instead of signing the reviewed template.");
  if (signed.pubkey !== pubkey) throw new Error("The signer returned an event for a different public key.");
  if (!validateEvent(signed) || !verifyEvent(signed)) throw new Error("The signer returned an invalid Nostr event.");
  return signed;
}

export function buildUploadAuthorisation(
  sha256: string,
  server: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  lifetimeSeconds = 90,
): EventTemplate {
  const hash = assertHex64(sha256, "Blob SHA-256");
  const hostname = new URL(normaliseBlossomServer(server)).hostname.toLowerCase();
  if (lifetimeSeconds < 30 || lifetimeSeconds > 300) throw new Error("Upload authorisation lifetime must be between 30 and 300 seconds.");
  const createdAt = Math.max(0, nowSeconds - 1);
  return {
    kind: AUTH_KIND,
    // BUD-11 requires created_at to be in the past. One second avoids an
    // equality rejection on servers using a strict wall-clock comparison.
    created_at: createdAt,
    tags: [
      ["t", "upload"],
      ["expiration", String(createdAt + lifetimeSeconds)],
      ["server", hostname],
      ["x", hash],
    ],
    content: `Upload blob ${hash} to ${hostname}`,
  };
}

export function encodeNostrAuthorisation(event: SignedNostrEvent): string {
  if (!validateEvent(event) || !verifyEvent(event)) throw new Error("Invalid Blossom authorisation signature.");
  if (event.kind !== AUTH_KIND || !exactTag(event, "t", "upload")) throw new Error("Not a Blossom upload authorisation event.");
  if (!event.tags.some((tag) => tag[0] === "expiration")
    || !event.tags.some((tag) => tag[0] === "server")
    || !event.tags.some((tag) => tag[0] === "x")) {
    throw new Error("Blossom upload authorisation is not fully scoped.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Nostr ${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "")}`;
}

export function buildFileEvent(publication: HybridPublication, nowSeconds = Math.floor(Date.now() / 1000)): EventTemplate {
  const { inspected, descriptor, torrent } = publication;
  return {
    kind: FILE_KIND,
    created_at: nowSeconds,
    tags: [
      ["url", descriptor.url],
      ["m", descriptor.type.toLowerCase()],
      ["x", inspected.sha256],
      ["ox", inspected.sha256],
      ["size", String(inspected.size)],
      ["magnet", torrent.magnetUri],
      ["i", torrent.infoHash],
      ["alt", inspected.name],
    ],
    content: inspected.name,
  };
}

export function buildTorrentEvent(
  inspected: HybridPublication["inspected"],
  torrent: TorrentPlan,
  nowSeconds = Math.floor(Date.now() / 1000),
): EventTemplate {
  return {
    kind: TORRENT_KIND,
    created_at: nowSeconds,
    tags: [
      ["title", inspected.name],
      ["x", torrent.infoHash],
      ["file", inspected.name, String(inspected.size)],
      ...torrent.trackers.map((tracker) => ["tracker", tracker]),
    ],
    content: `Wildbloom distribution for ${inspected.name}`,
  };
}

export function validateBlobDescriptor(
  value: unknown,
  expected: { sha256: string; size: number },
): BlobDescriptor {
  if (!value || typeof value !== "object") throw new Error("Blossom returned an invalid blob descriptor.");
  const candidate = value as Record<string, unknown>;
  const sha256 = assertHex64(String(candidate.sha256 ?? ""), "Descriptor SHA-256");
  if (sha256 !== expected.sha256) throw new Error("Blossom returned a descriptor for different bytes.");
  const size = Number(candidate.size);
  if (!Number.isSafeInteger(size) || size !== expected.size) throw new Error("Blossom returned the wrong blob size.");
  const type = String(candidate.type ?? "").toLowerCase();
  if (!type || type.length > 255 || /[\u0000-\u001f\u007f]/u.test(type)) throw new Error("Blossom returned an invalid MIME type.");
  const uploaded = Number(candidate.uploaded);
  if (!Number.isSafeInteger(uploaded) || uploaded < 0) throw new Error("Blossom returned an invalid upload timestamp.");
  const url = normaliseBlossomUrl(String(candidate.url ?? ""), sha256);
  return { url, sha256, size, type, uploaded };
}

export function resolveHybridEvent(event: SignedNostrEvent): ResolvedHybridEvent {
  if (!validateEvent(event) || !verifyEvent(event)) throw new Error("The Nostr event signature is invalid.");
  if (event.kind !== FILE_KIND) throw new Error("Expected a NIP-94 kind 1063 file event.");

  const sha256 = assertHex64(uniqueTag(event.tags, "x"), "File SHA-256");
  const url = normaliseBlossomUrl(uniqueTag(event.tags, "url"), sha256);
  const mimeType = uniqueTag(event.tags, "m").toLowerCase();
  if (!mimeType || mimeType.length > 255 || /[\u0000-\u001f\u007f]/u.test(mimeType)) throw new Error("Invalid MIME type.");
  const size = Number(uniqueTag(event.tags, "size"));
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid file size.");
  assertPrototypeFileSize(size);
  const infoHash = assertHex40(uniqueTag(event.tags, "i"), "Torrent info hash");
  const magnetUri = uniqueTag(event.tags, "magnet");
  const magnet = new URL(magnetUri);
  if (magnet.protocol !== "magnet:") throw new Error("Invalid magnet URI.");
  const exactTopics = magnet.searchParams.getAll("xt");
  if (!exactTopics.includes(`urn:btih:${infoHash}`) && !exactTopics.includes(`urn:btih:${infoHash.toUpperCase()}`)) {
    throw new Error("The magnet URI does not match the signed torrent info hash.");
  }
  const name = sanitiseFileName(event.tags.find((tag) => tag[0] === "alt")?.[1] ?? event.content);
  return { event, url, mimeType, sha256, size, magnetUri, infoHash, name };
}
