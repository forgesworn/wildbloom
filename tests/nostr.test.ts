import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  buildFileEvent,
  buildTorrentEvent,
  buildUploadAuthorisation,
  encodeNostrAuthorisation,
  resolveHybridEvent,
  signEventExactly,
  validateBlobDescriptor,
} from "../src/core/nostr.js";
import type { HybridPublication, SignedNostrEvent, SignerPort } from "../src/core/types.js";

const secret = new Uint8Array(32).fill(7);
const pubkey = getPublicKey(secret);
const sha256 = "ab".repeat(32);
const infoHash = "cd".repeat(20);
const publication: HybridPublication = {
  inspected: {
    file: new File(["hello"], "hello.txt", { type: "text/plain" }),
    name: "hello.txt",
    extension: "txt",
    sha256,
    size: 5,
    type: "text/plain",
  },
  descriptor: {
    url: `https://cdn.example.com/${sha256}.txt`,
    sha256,
    size: 5,
    type: "text/plain",
    uploaded: 100,
  },
  torrent: {
    torrentBytes: new Uint8Array([1]),
    torrentBlob: new Blob([new Uint8Array([1])]),
    infoHash,
    magnetUri: `magnet:?xt=urn%3Abtih%3A${infoHash}&ws=https%3A%2F%2Fcdn.example.com%2F${sha256}.txt`,
    name: "hello.txt",
    trackers: ["wss://tracker.example.com/"],
    webSeed: `https://cdn.example.com/${sha256}.txt`,
  },
};

const signer: SignerPort = {
  async getPublicKey() { return pubkey; },
  async signEvent(template) { return finalizeEvent(template, secret); },
};

describe("Blossom authorisation", () => {
  it("is short-lived and scoped to server and exact hash", async () => {
    const template = buildUploadAuthorisation(sha256, "https://CDN.example.com", 1_000, 90);
    expect(template.tags).toEqual([
      ["t", "upload"],
      ["expiration", "1089"],
      ["server", "cdn.example.com"],
      ["x", sha256],
    ]);
    const signed = await signEventExactly(template, signer, pubkey);
    const encoded = encodeNostrAuthorisation(signed);
    expect(encoded).toMatch(/^Nostr [A-Za-z0-9_-]+$/u);
    expect(encoded).not.toContain("=");
  });

  it("rejects a signer that changes reviewed fields", async () => {
    const malicious: SignerPort = {
      async getPublicKey() { return pubkey; },
      async signEvent(template) {
        return finalizeEvent({ ...template, tags: [["t", "delete"]] }, secret);
      },
    };
    await expect(signEventExactly(buildUploadAuthorisation(sha256, "https://cdn.example.com"), malicious, pubkey))
      .rejects.toThrow(/changed/u);
  });
});

describe("hybrid Nostr events", () => {
  it("builds NIP-94 and NIP-35 shapes without confusing their two x hashes", async () => {
    const fileTemplate = buildFileEvent(publication, 2_000);
    const torrentTemplate = buildTorrentEvent(publication.inspected, publication.torrent, 2_000);
    expect(fileTemplate.kind).toBe(1063);
    expect(fileTemplate.tags).toContainEqual(["x", sha256]);
    expect(fileTemplate.tags).toContainEqual(["i", infoHash]);
    expect(torrentTemplate.kind).toBe(2003);
    expect(torrentTemplate.tags).toContainEqual(["x", infoHash]);
    expect(torrentTemplate.tags).not.toContainEqual(["x", sha256]);

    const signed = await signEventExactly(fileTemplate, signer, pubkey);
    expect(resolveHybridEvent(signed)).toMatchObject({ sha256, infoHash, name: "hello.txt", size: 5 });
  });

  it("rejects a validly signed event whose magnet points at another torrent", () => {
    const template = buildFileEvent(publication, 2_000);
    const wrong = finalizeEvent({
      ...template,
      tags: template.tags.map((tag) => tag[0] === "magnet" ? ["magnet", `magnet:?xt=urn:btih:${"ef".repeat(20)}`] : tag),
    }, secret) as SignedNostrEvent;
    expect(() => resolveHybridEvent(wrong)).toThrow(/does not match/u);
  });
});

describe("Blossom descriptors", () => {
  it("accepts only the expected hash and size", () => {
    expect(validateBlobDescriptor(publication.descriptor, { sha256, size: 5 })).toEqual(publication.descriptor);
    expect(() => validateBlobDescriptor({ ...publication.descriptor, sha256: "00".repeat(32) }, { sha256, size: 5 }))
      .toThrow(/different bytes/u);
    expect(() => validateBlobDescriptor({ ...publication.descriptor, url: "http://cdn.example.com/blob" }, { sha256, size: 5 }))
      .toThrow();
  });
});
