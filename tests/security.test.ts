import { sha3_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import {
  assertV3OnionHostname,
  assertPrototypeFileSize,
  fileExtension,
  normaliseBlossomServer,
  normaliseBlossomUrl,
  normaliseRelayUrl,
  normaliseTrackerUrl,
  parseEndpointList,
  sanitiseFileName,
} from "../src/core/security.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let result = "";
  let bits = 0;
  let accumulator = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32[(accumulator >>> bits) & 31];
    }
  }
  return result;
}

function onionHostname(): string {
  const publicKey = new Uint8Array(32).fill(17);
  const version = new Uint8Array([3]);
  const prefix = new TextEncoder().encode(".onion checksum");
  const checksumInput = new Uint8Array(prefix.length + publicKey.length + 1);
  checksumInput.set(prefix);
  checksumInput.set(publicKey, prefix.length);
  checksumInput.set(version, prefix.length + publicKey.length);
  const address = new Uint8Array(35);
  address.set(publicKey);
  address.set(sha3_256(checksumInput).subarray(0, 2), 32);
  address.set(version, 34);
  return `${base32(address)}.onion`;
}

describe("secure endpoint handling", () => {
  it("accepts secure remote services and explicit local development", () => {
    expect(normaliseBlossomServer("https://cdn.example.com/")).toBe("https://cdn.example.com");
    expect(normaliseRelayUrl("wss://relay.example.com/path")).toBe("wss://relay.example.com/path");
    expect(normaliseTrackerUrl("ws://localhost:8000/announce")).toBe("ws://localhost:8000/announce");
  });

  it("rejects remote plaintext and embedded credentials", () => {
    expect(() => normaliseBlossomServer("http://cdn.example.com")).toThrow(/https/u);
    expect(() => normaliseRelayUrl("wss://user:pass@relay.example.com")).toThrow(/credentials/u);
    expect(() => normaliseTrackerUrl("http://tracker.example.com")).toThrow(/wss/u);
  });

  it("requires Blossom origins rather than attacker-controlled paths", () => {
    expect(() => normaliseBlossomServer("https://cdn.example.com/upload")).toThrow(/origin only/u);
    expect(() => normaliseBlossomServer("https://cdn.example.com/?next=evil")).toThrow(/origin only/u);
  });

  it("requires an exact content-addressed Blossom object path", () => {
    const hash = "ab".repeat(32);
    expect(normaliseBlossomUrl(`https://cdn.example.com/${hash}.bin`, hash)).toBe(`https://cdn.example.com/${hash}.bin`);
    expect(() => normaliseBlossomUrl(`https://cdn.example.com/archive/${hash}/other.bin`, hash)).toThrow(/path/u);
    expect(() => normaliseBlossomUrl(`https://cdn.example.com/${hash}.bin?token=secret`, hash)).toThrow(/query/u);
  });

  it("accepts only checksum-valid v3 onion services in Tor-only mode", () => {
    const onion = onionHostname();
    expect(assertV3OnionHostname(onion)).toBe(onion);
    expect(normaliseBlossomServer(`http://${onion}`, "tor")).toBe(`http://${onion}`);
    expect(normaliseRelayUrl(`ws://${onion}`, "tor")).toBe(`ws://${onion}/`);
    expect(() => normaliseBlossomServer(`https://${onion}`, "direct")).toThrow(/Tor-only/u);
    expect(() => normaliseTrackerUrl(`wss://${onion}`, "tor")).toThrow(/disabled/u);

    const corrupted = `${onion[0] === "a" ? "b" : "a"}${onion.slice(1)}`;
    expect(() => assertV3OnionHostname(corrupted)).toThrow(/checksum/u);
    expect(() => assertV3OnionHostname(`sub.${onion}`)).toThrow(/exact/u);
  });

  it("caps endpoint fan-out before opening network connections", () => {
    const endpoints = Array.from({ length: 9 }, (_, index) => `wss://relay${index}.example.com`).join("\n");
    expect(() => parseEndpointList(endpoints, normaliseRelayUrl)).toThrow(/At most 8/u);
  });
});

describe("file boundaries", () => {
  it("removes paths and control characters from display names", () => {
    expect(sanitiseFileName("../../private/<demo>\u0000.txt")).toBe("_demo_.txt");
    expect(sanitiseFileName(".../../")).toBe("blob.bin");
  });

  it("uses a conservative extension fallback", () => {
    expect(fileExtension("photo.JPEG")).toBe("jpeg");
    expect(fileExtension("README")).toBe("bin");
    expect(fileExtension("file.this-extension-is-too-long")).toBe("bin");
  });

  it("rejects empty and oversized files", () => {
    expect(() => assertPrototypeFileSize(0)).toThrow(/non-empty/u);
    expect(() => assertPrototypeFileSize(256 * 1024 * 1024 + 1)).toThrow(/limited/u);
  });
});
