import { sha3_256 } from "@noble/hashes/sha3.js";
import type { NetworkProfile } from "./types.js";

export const MAX_PROTOTYPE_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_PROTOTYPE_TRANSFER_BYTES = MAX_PROTOTYPE_FILE_BYTES + 2 * 1024 * 1024;
export const MAX_RELAY_MESSAGE_BYTES = 1024 * 1024;
export const MAX_NETWORK_ENDPOINTS = 8;

export const HEX_64 = /^[0-9a-f]{64}$/;
export const HEX_40 = /^[0-9a-f]{40}$/;
const V3_ONION = /^([a-z2-7]{56})\.onion$/u;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ONION_CHECKSUM_PREFIX = new TextEncoder().encode(".onion checksum");

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function decodeBase32(value: string): Uint8Array {
  let bits = 0;
  let accumulator = 0;
  const output: number[] = [];
  for (const character of value) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("Invalid v3 onion service address.");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits !== 0 || output.length !== 35) throw new Error("Invalid v3 onion service address.");
  return new Uint8Array(output);
}

export function assertV3OnionHostname(hostname: string): string {
  const match = V3_ONION.exec(hostname.toLowerCase());
  if (!match?.[1]) throw new Error("Tor-only mode accepts exact v3 .onion hostnames only.");
  const decoded = decodeBase32(match[1]);
  const publicKey = decoded.subarray(0, 32);
  const checksum = decoded.subarray(32, 34);
  const version = decoded[34];
  if (version !== 3) throw new Error("Invalid v3 onion service version.");
  const checksumInput = new Uint8Array(ONION_CHECKSUM_PREFIX.length + publicKey.length + 1);
  checksumInput.set(ONION_CHECKSUM_PREFIX);
  checksumInput.set(publicKey, ONION_CHECKSUM_PREFIX.length);
  checksumInput[checksumInput.length - 1] = version;
  const expected = sha3_256(checksumInput).subarray(0, 2);
  if (checksum[0] !== expected[0] || checksum[1] !== expected[1]) {
    throw new Error("Invalid v3 onion service checksum.");
  }
  return `${match[1]}.onion`;
}

function requireSecureTransport(
  url: URL,
  secureProtocol: string,
  localProtocol: string,
  profile: NetworkProfile,
): void {
  if (profile === "tor") {
    assertV3OnionHostname(url.hostname);
    if (url.protocol === secureProtocol || url.protocol === localProtocol) return;
    throw new Error(`Tor-only endpoints must use ${secureProtocol} or ${localProtocol}.`);
  }
  if (url.hostname.endsWith(".onion")) throw new Error("Select Tor-only mode before using an onion service.");
  if (url.protocol === secureProtocol) return;
  if (url.protocol === localProtocol && isLocalHost(url.hostname)) return;
  throw new Error(`Only ${secureProtocol} endpoints are accepted (or ${localProtocol} localhost for development).`);
}

function rejectCredentials(url: URL): void {
  if (url.username || url.password) throw new Error("Endpoint URLs must not contain credentials.");
}

export function normaliseBlossomServer(value: string, profile: NetworkProfile = "direct"): string {
  const url = new URL(value.trim());
  requireSecureTransport(url, "https:", "http:", profile);
  rejectCredentials(url);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("A Blossom server must be an origin only, without a path, query or fragment.");
  }
  return url.origin;
}

export function normaliseBlossomUrl(
  value: string,
  expectedHash?: string,
  profile: NetworkProfile = "direct",
): string {
  const url = new URL(value.trim());
  requireSecureTransport(url, "https:", "http:", profile);
  rejectCredentials(url);
  if (url.hash) throw new Error("Blossom blob URLs must not contain fragments.");
  if (expectedHash) {
    if (url.search) throw new Error("Content-addressed Blossom URLs must not contain a query string.");
    const leaf = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const escapedHash = expectedHash.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (!new RegExp(`^${escapedHash}(?:\\.[a-z0-9]{1,10})?$`, "u").test(leaf)) {
      throw new Error("The Blossom URL path is not the expected SHA-256 object.");
    }
  }
  return url.toString();
}

export function normaliseRelayUrl(value: string, profile: NetworkProfile = "direct"): string {
  const url = new URL(value.trim());
  requireSecureTransport(url, "wss:", "ws:", profile);
  rejectCredentials(url);
  if (url.hash) throw new Error("Relay URLs must not contain fragments.");
  return url.toString();
}

export function normaliseTrackerUrl(value: string, profile: NetworkProfile = "direct"): string {
  if (profile === "tor") throw new Error("WebTorrent is disabled in Tor-only mode.");
  const url = new URL(value.trim());
  requireSecureTransport(url, "wss:", "ws:", profile);
  rejectCredentials(url);
  if (url.hash) throw new Error("Tracker URLs must not contain fragments.");
  return url.toString();
}

export function parseEndpointList(value: string, parser: (entry: string) => string): string[] {
  const entries = value.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > MAX_NETWORK_ENDPOINTS) throw new Error(`At most ${MAX_NETWORK_ENDPOINTS} endpoints may be used at once.`);
  if (entries.some((entry) => entry.length > 2048)) throw new Error("An endpoint URL is unexpectedly long.");
  return [...new Set(entries.map(parser))];
}

export function sanitiseFileName(value: string): string {
  const leaf = value.split(/[\\/]/u).at(-1) ?? "";
  const cleaned = leaf
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[<>:"|?*]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();
  const fallback = cleaned || "blob.bin";
  return fallback.length <= 180 ? fallback : fallback.slice(0, 180);
}

export function fileExtension(name: string): string {
  const match = /\.([a-z0-9]{1,10})$/iu.exec(name);
  return match?.[1]?.toLowerCase() ?? "bin";
}

export function assertPrototypeFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Choose a non-empty file.");
  if (size > MAX_PROTOTYPE_FILE_BYTES) {
    throw new Error(`This version is limited to ${MAX_PROTOTYPE_FILE_BYTES / 1024 / 1024} MiB files.`);
  }
}

export function assertPrototypeTransferSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Choose a non-empty transfer payload.");
  if (size > MAX_PROTOTYPE_TRANSFER_BYTES) {
    throw new Error(`Transfer payloads are limited to ${MAX_PROTOTYPE_TRANSFER_BYTES / 1024 / 1024} MiB.`);
  }
}

export function assertHex64(value: string, label: string): string {
  const normalised = value.toLowerCase();
  if (!HEX_64.test(normalised)) throw new Error(`${label} must be 64 lowercase hexadecimal characters.`);
  return normalised;
}

export function assertHex40(value: string, label: string): string {
  const normalised = value.toLowerCase();
  if (!HEX_40.test(normalised)) throw new Error(`${label} must be a 40-character BitTorrent v1 info hash.`);
  return normalised;
}

export function safeDiagnostic(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300);
}
