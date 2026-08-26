import { validateEvent, verifyEvent } from "nostr-tools";
import type {
  BlobDescriptor,
  EventTemplate,
  HybridPublication,
  NetworkProfile,
  ResolvedHybridEvent,
  SignedNostrEvent,
  SignerPort,
  TorrentPlan,
  EncryptionScheme,
} from "./types.js";
import {
  WILDBLOOM_ENCRYPTED_FILE_NAME,
  WILDBLOOM_ENCRYPTED_MIME_TYPE,
  WILDBLOOM_ENCRYPTION,
} from "./types.js";
import {
  assertHex40,
  assertHex64,
  assertPrototypeTransferSize,
  normaliseBlossomServer,
  normaliseBlossomUrl,
  normaliseTrackerUrl,
  sanitiseFileName,
} from "./security.js";

const AUTH_KIND = 24242;
const FILE_KIND = 1063;
const TORRENT_KIND = 2003;

function uniqueTag(tags: readonly string[][], name: string, maximumLength = 8192): string {
  const matches = tags.filter((tag) => tag[0] === name);
  if (matches.length !== 1 || matches[0]?.length !== 2 || typeof matches[0][1] !== "string") {
    throw new Error(`Signed event must contain exactly one scalar ${name} tag.`);
  }
  const value = matches[0][1];
  if (value.length > maximumLength) throw new Error(`Signed event ${name} tag is unexpectedly large.`);
  return value;
}

function optionalUniqueTag(tags: readonly string[][], name: string, maximumLength = 8192): string | undefined {
  const matches = tags.filter((tag) => tag[0] === name);
  if (matches.length === 0) return undefined;
  return uniqueTag(tags, name, maximumLength);
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
  profile: NetworkProfile = "direct",
): EventTemplate {
  const hash = assertHex64(sha256, "Blob SHA-256");
  const hostname = new URL(normaliseBlossomServer(server, profile)).hostname.toLowerCase();
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

export function encodeNostrAuthorisation(
  event: SignedNostrEvent,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  if (!validateEvent(event) || !verifyEvent(event)) throw new Error("Invalid Blossom authorisation signature.");
  if (event.kind !== AUTH_KIND || uniqueTag(event.tags, "t", 32) !== "upload") {
    throw new Error("Not a Blossom upload authorisation event.");
  }
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) throw new Error("Invalid Blossom authorisation timestamp.");
  const expirationText = uniqueTag(event.tags, "expiration", 16);
  if (!/^[0-9]{1,16}$/u.test(expirationText)) throw new Error("Invalid Blossom authorisation expiration.");
  const expiration = Number(expirationText);
  if (!Number.isSafeInteger(expiration)
    || expiration - event.created_at < 30
    || expiration - event.created_at > 300) {
    throw new Error("Blossom upload authorisation is not short-lived.");
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new Error("Invalid current timestamp.");
  if (event.created_at >= nowSeconds || expiration <= nowSeconds) {
    throw new Error("Blossom upload authorisation is not currently valid.");
  }
  const server = uniqueTag(event.tags, "server", 255);
  let serverUrl: URL;
  try {
    serverUrl = new URL(`https://${server}`);
  } catch {
    throw new Error("Blossom upload authorisation has an invalid server scope.");
  }
  if (server !== server.toLowerCase() || serverUrl.hostname !== server || serverUrl.port || serverUrl.pathname !== "/") {
    throw new Error("Blossom upload authorisation has an invalid server scope.");
  }
  const hash = assertHex64(uniqueTag(event.tags, "x", 64), "Authorisation blob SHA-256");
  if (event.content !== `Upload blob ${hash} to ${server}`) {
    throw new Error("Blossom upload authorisation has an unexpected human-readable purpose.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Nostr ${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "")}`;
}

export function buildFileEvent(publication: HybridPublication, nowSeconds = Math.floor(Date.now() / 1000)): EventTemplate {
  const { inspected, descriptor, torrent } = publication;
  if (publication.encryption && (
    inspected.name !== WILDBLOOM_ENCRYPTED_FILE_NAME
    || inspected.type !== WILDBLOOM_ENCRYPTED_MIME_TYPE
  )) {
    throw new Error("Encrypted Wildbloom events must describe the canonical public envelope.");
  }
  const alt = publication.encryption ? "Encrypted Wildbloom file" : `File: ${inspected.name}`;
  const torrentTags = torrent ? [
    ["magnet", torrent.magnetUri],
    ["i", torrent.infoHash],
  ] : [];
  const encryptionTags = publication.encryption ? [["encryption", publication.encryption]] : [];
  return {
    kind: FILE_KIND,
    created_at: nowSeconds,
    tags: [
      ["url", descriptor.url],
      ["m", inspected.type.toLowerCase()],
      ["x", inspected.sha256],
      // Client-side encryption happens before upload. NIP-94's `ox` is the
      // blob before any upload-server transformation, so it is the public
      // envelope hash too and must never be replaced with the source hash.
      ["ox", inspected.sha256],
      ["size", String(inspected.size)],
      ...torrentTags,
      ...encryptionTags,
      ["alt", alt],
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
  expected: { sha256: string; size: number; type?: string },
  profile: NetworkProfile = "direct",
): BlobDescriptor {
  if (!value || typeof value !== "object") throw new Error("Blossom returned an invalid blob descriptor.");
  const candidate = value as Record<string, unknown>;
  const sha256 = assertHex64(String(candidate.sha256 ?? ""), "Descriptor SHA-256");
  if (sha256 !== expected.sha256) throw new Error("Blossom returned a descriptor for different bytes.");
  const size = Number(candidate.size);
  if (!Number.isSafeInteger(size) || size !== expected.size) throw new Error("Blossom returned the wrong blob size.");
  const type = String(candidate.type ?? "").toLowerCase();
  if (!type || type.length > 255 || /[\u0000-\u001f\u007f]/u.test(type)) throw new Error("Blossom returned an invalid MIME type.");
  if (expected.type && type !== expected.type.toLowerCase()) throw new Error("Blossom returned the wrong MIME type.");
  const uploaded = Number(candidate.uploaded);
  if (!Number.isSafeInteger(uploaded) || uploaded < 0) throw new Error("Blossom returned an invalid upload timestamp.");
  const url = normaliseBlossomUrl(String(candidate.url ?? ""), sha256, profile);
  return { url, sha256, size, type, uploaded };
}

function validateEventBounds(event: SignedNostrEvent): void {
  if (event.content.length > 4096 || event.tags.length > 64) throw new Error("The Nostr event exceeds Wildbloom's safety limits.");
  let tagBytes = 0;
  for (const tag of event.tags) {
    if (tag.length > 8 || tag.some((value) => typeof value !== "string")) throw new Error("The Nostr event contains an invalid tag.");
    tagBytes += tag.reduce((total, value) => total + value.length, 0);
  }
  if (tagBytes > 64 * 1024) throw new Error("The Nostr event tags are unexpectedly large.");
}

function sanitiseMagnet(
  magnetUri: string,
  infoHash: string,
  size: number,
  name: string,
  blossomUrl: string,
  profile: NetworkProfile,
): { magnetUri: string; trackers: string[] } {
  if (profile === "tor") throw new Error("Torrent metadata is disabled in Tor-only mode.");
  if (magnetUri.length > 16 * 1024) throw new Error("The magnet URI is unexpectedly large.");
  const magnet = new URL(magnetUri);
  if (magnet.protocol !== "magnet:") throw new Error("Invalid magnet URI.");
  const exactTopics = magnet.searchParams.getAll("xt");
  if (exactTopics.length !== 1 || exactTopics[0]?.toLowerCase() !== `urn:btih:${infoHash}`) {
    throw new Error("The magnet URI does not match the signed torrent info hash.");
  }
  const sizes = magnet.searchParams.getAll("xl");
  if (sizes.length !== 1 || sizes[0] !== String(size)) throw new Error("The magnet URI does not match the signed file size.");
  const webSeeds = magnet.searchParams.getAll("ws");
  if (webSeeds.length !== 1 || normaliseBlossomUrl(webSeeds[0] as string, undefined, profile) !== blossomUrl) {
    throw new Error("The magnet URI does not use the signed Blossom URL as its only web seed.");
  }
  const displayNames = magnet.searchParams.getAll("dn");
  if (displayNames.length !== 1 || sanitiseFileName(displayNames[0] as string) !== name) {
    throw new Error("The magnet URI does not match the signed display name.");
  }
  const trackers = [...new Set(magnet.searchParams.getAll("tr").map((tracker) => normaliseTrackerUrl(tracker, profile)))];
  if (trackers.length === 0 || trackers.length > 8) throw new Error("The magnet URI must contain between one and eight safe trackers.");
  const parameters = [
    `xt=urn:btih:${infoHash}`,
    `dn=${encodeURIComponent(name)}`,
    `xl=${size}`,
    ...trackers.map((tracker) => `tr=${encodeURIComponent(tracker)}`),
    `ws=${encodeURIComponent(blossomUrl)}`,
  ];
  return { magnetUri: `magnet:?${parameters.join("&")}`, trackers };
}

export function resolveHybridEvent(
  event: SignedNostrEvent,
  profile: NetworkProfile = "direct",
): ResolvedHybridEvent {
  if (!validateEvent(event) || !verifyEvent(event)) throw new Error("The Nostr event signature is invalid.");
  if (event.kind !== FILE_KIND) throw new Error("Expected a NIP-94 kind 1063 file event.");
  validateEventBounds(event);

  const sha256 = assertHex64(uniqueTag(event.tags, "x"), "File SHA-256");
  const originalSha256 = assertHex64(uniqueTag(event.tags, "ox"), "Original file SHA-256");
  if (originalSha256 !== sha256) {
    throw new Error("Wildbloom requires the NIP-94 x and ox hashes to identify the same untransformed bytes.");
  }
  const url = normaliseBlossomUrl(uniqueTag(event.tags, "url"), sha256, profile);
  const mimeTypeTag = uniqueTag(event.tags, "m", 255);
  const mimeType = mimeTypeTag.toLowerCase();
  if (!mimeType || mimeType.length > 255 || /[\u0000-\u001f\u007f]/u.test(mimeType)) throw new Error("Invalid MIME type.");
  const size = Number(uniqueTag(event.tags, "size"));
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid file size.");
  assertPrototypeTransferSize(size);
  const alt = optionalUniqueTag(event.tags, "alt", 280);
  const name = sanitiseFileName(event.content);
  const encryptionValue = optionalUniqueTag(event.tags, "encryption", 80);
  let encryption: EncryptionScheme | undefined;
  if (encryptionValue !== undefined) {
    if (encryptionValue !== WILDBLOOM_ENCRYPTION) throw new Error("The event uses an unsupported encryption scheme.");
    if (event.content !== WILDBLOOM_ENCRYPTED_FILE_NAME
      || mimeTypeTag !== WILDBLOOM_ENCRYPTED_MIME_TYPE
      || alt !== "Encrypted Wildbloom file") {
      throw new Error("The encrypted event does not use Wildbloom's canonical public envelope metadata.");
    }
    encryption = encryptionValue;
  }
  const infoHashTag = optionalUniqueTag(event.tags, "i", 40);
  const magnetTag = optionalUniqueTag(event.tags, "magnet", 16 * 1024);
  if ((infoHashTag === undefined) !== (magnetTag === undefined)) throw new Error("Torrent info hash and magnet tags must appear together.");
  if (infoHashTag !== undefined && magnetTag !== undefined) {
    const infoHash = assertHex40(infoHashTag, "Torrent info hash");
    const magnet = sanitiseMagnet(magnetTag, infoHash, size, name, url, profile);
    return { event, url, mimeType, sha256, size, magnetUri: magnet.magnetUri, infoHash, trackers: magnet.trackers, name, ...(encryption ? { encryption } : {}) };
  }
  return { event, url, mimeType, sha256, size, trackers: [], name, ...(encryption ? { encryption } : {}) };
}
