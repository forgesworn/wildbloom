import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  buildFileEvent,
  buildTorrentEvent,
  buildUploadAuthorisation,
  assertSignedEventExactly,
  encodeNostrAuthorisation,
  parseSignedEventJson,
  resolveHybridEvent,
  signEventExactly,
  validateBlobDescriptor,
} from "../src/core/nostr.js";
import type { HybridPublication, SignedNostrEvent, SignerPort } from "../src/core/types.js";
import { WILDBLOOM_ENCRYPTION } from "../src/core/types.js";

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
    magnetUri: `magnet:?xt=urn%3Abtih%3A${infoHash}&dn=hello.txt&xl=5&tr=wss%3A%2F%2Ftracker.example.com%2F&ws=https%3A%2F%2Fcdn.example.com%2F${sha256}.txt`,
    name: "hello.txt",
    trackers: ["wss://tracker.example.com/"],
    webSeed: `https://cdn.example.com/${sha256}.txt`,
  },
};
const encryptedPublication: HybridPublication = {
  inspected: {
    ...publication.inspected,
    file: new File(["hello"], "wildbloom.wbenc", { type: "application/vnd.wildbloom.encrypted" }),
    name: "wildbloom.wbenc",
    extension: "wbenc",
    type: "application/vnd.wildbloom.encrypted",
  },
  descriptor: {
    ...publication.descriptor,
    url: `https://cdn.example.com/${sha256}.wbenc`,
    type: "application/vnd.wildbloom.encrypted",
  },
  encryption: WILDBLOOM_ENCRYPTION,
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
    const encoded = encodeNostrAuthorisation(signed, 1_000);
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

  it("accepts a strict external signature over the exact reviewed template", () => {
    const template = buildUploadAuthorisation(sha256, "https://cdn.example.com", 1_000, 300);
    const signed = finalizeEvent(template, secret) as SignedNostrEvent;
    expect(JSON.stringify(parseSignedEventJson(template, JSON.stringify(signed), pubkey))).toBe(JSON.stringify(signed));
    expect(JSON.stringify(assertSignedEventExactly(template, signed))).toBe(JSON.stringify(signed));
  });

  it("rejects hostile external signing responses", () => {
    const template = buildUploadAuthorisation(sha256, "https://cdn.example.com", 1_000, 300);
    const signed = finalizeEvent(template, secret) as SignedNostrEvent;
    expect(() => parseSignedEventJson(template, "not JSON", pubkey)).toThrow(/JSON is invalid/u);
    expect(() => parseSignedEventJson(template, JSON.stringify({ ...signed, extra: "surprise" }), pubkey))
      .toThrow(/unexpected Nostr event shape/u);
    expect(() => parseSignedEventJson(template, JSON.stringify({ ...signed, content: "Upload anything" }), pubkey))
      .toThrow(/changed the event/u);
    expect(() => parseSignedEventJson(template, JSON.stringify(signed), "ef".repeat(32)))
      .toThrow(/different public key/u);
    expect(() => parseSignedEventJson(template, `"${"x".repeat(128 * 1024)}"`, pubkey))
      .toThrow(/unexpectedly large/u);
  });

  it("refuses validly signed duplicate or long-lived upload scopes", () => {
    const template = buildUploadAuthorisation(sha256, "https://cdn.example.com", 1_000, 90);
    const duplicateServer = finalizeEvent({
      ...template,
      tags: [...template.tags, ["server", "evil.example"]],
    }, secret) as SignedNostrEvent;
    expect(() => encodeNostrAuthorisation(duplicateServer, 1_000)).toThrow(/scalar server/u);

    const longLived = finalizeEvent({
      ...template,
      tags: template.tags.map((tag) => tag[0] === "expiration" ? ["expiration", "1300"] : tag),
    }, secret) as SignedNostrEvent;
    expect(() => encodeNostrAuthorisation(longLived, 1_000)).toThrow(/short-lived/u);
  });

  it("refuses stale, future and misleading validly signed upload authority", () => {
    const template = buildUploadAuthorisation(sha256, "https://cdn.example.com", 1_000, 90);
    const signed = finalizeEvent(template, secret) as SignedNostrEvent;
    expect(() => encodeNostrAuthorisation(signed, 1_089)).toThrow(/not currently valid/u);
    expect(() => encodeNostrAuthorisation(signed, 999)).toThrow(/not currently valid/u);

    const misleading = finalizeEvent({ ...template, content: "Upload anything anywhere" }, secret) as SignedNostrEvent;
    expect(() => encodeNostrAuthorisation(misleading, 1_000)).toThrow(/human-readable purpose/u);
  });
});

describe("hybrid Nostr events", () => {
  it("builds NIP-94 and NIP-35 shapes without confusing their two x hashes", async () => {
    const fileTemplate = buildFileEvent(publication, 2_000);
    const torrentTemplate = buildTorrentEvent(publication.inspected, publication.torrent!, 2_000);
    expect(fileTemplate.kind).toBe(1063);
    expect(fileTemplate.tags).toContainEqual(["x", sha256]);
    expect(fileTemplate.tags).toContainEqual(["ox", sha256]);
    expect(fileTemplate.tags).toContainEqual(["i", infoHash]);
    expect(fileTemplate.tags).toContainEqual(["alt", "File: hello.txt"]);
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

  it("strips unrecognised magnet parameters and returns only validated trackers", () => {
    const template = buildFileEvent(publication, 2_000);
    const signed = finalizeEvent({
      ...template,
      tags: template.tags.map((tag) => tag[0] === "magnet" ? ["magnet", `${tag[1]}&xs=https%3A%2F%2Fevil.example%2Fmetadata.torrent`] : tag),
    }, secret) as SignedNostrEvent;
    const resolved = resolveHybridEvent(signed);
    expect(resolved.magnetUri).not.toContain("evil.example");
    expect(resolved.trackers).toEqual(["wss://tracker.example.com/"]);
  });

  it("rejects signed magnets that change size, web seed or tracker transport", () => {
    const template = buildFileEvent(publication, 2_000);
    for (const replacement of [
      publication.torrent!.magnetUri.replace("xl=5", "xl=6"),
      publication.torrent!.magnetUri.replace("cdn.example.com", "other.example.com"),
      publication.torrent!.magnetUri.replace("wss%3A", "ws%3A"),
    ]) {
      const signed = finalizeEvent({
        ...template,
        tags: template.tags.map((tag) => tag[0] === "magnet" ? ["magnet", replacement] : tag),
      }, secret) as SignedNostrEvent;
      expect(() => resolveHybridEvent(signed)).toThrow();
    }
  });

  it("supports an encrypted Blossom-only event without inventing swarm support", () => {
    const template = buildFileEvent(encryptedPublication, 2_000);
    expect(template.tags).toContainEqual(["encryption", WILDBLOOM_ENCRYPTION]);
    expect(template.tags).toContainEqual(["alt", "Encrypted Wildbloom file"]);
    expect(template.tags).toContainEqual(["x", sha256]);
    expect(template.tags).toContainEqual(["ox", sha256]);
    expect(template.tags.some((tag) => tag[0] === "magnet")).toBe(false);
    const resolved = resolveHybridEvent(finalizeEvent(template, secret) as SignedNostrEvent);
    expect(resolved.encryption).toBe(WILDBLOOM_ENCRYPTION);
    expect(resolved.magnetUri).toBeUndefined();
    expect(resolved.trackers).toEqual([]);
  });

  it("rejects validly signed ambiguous scalar tags and unsupported encryption claims", () => {
    const template = buildFileEvent(publication, 2_000);
    const malformedDuplicate = finalizeEvent({
      ...template,
      tags: [...template.tags, ["x"]],
    }, secret) as SignedNostrEvent;
    expect(() => resolveHybridEvent(malformedDuplicate)).toThrow(/scalar x/u);

    const unsupportedEncryption = finalizeEvent({
      ...template,
      tags: [...template.tags, ["encryption", "unknown-scheme"]],
    }, secret) as SignedNostrEvent;
    expect(() => resolveHybridEvent(unsupportedEncryption)).toThrow(/unsupported encryption/u);
  });

  it("rejects validly signed transformed hashes and false Wildbloom privacy metadata", () => {
    const plaintextTemplate = buildFileEvent(publication, 2_000);
    const transformed = finalizeEvent({
      ...plaintextTemplate,
      tags: plaintextTemplate.tags.map((tag) => tag[0] === "ox" ? ["ox", "ef".repeat(32)] : tag),
    }, secret) as SignedNostrEvent;
    expect(() => resolveHybridEvent(transformed)).toThrow(/same untransformed bytes/u);
    for (const tags of [
      plaintextTemplate.tags.filter((tag) => tag[0] !== "ox"),
      [...plaintextTemplate.tags, ["ox", sha256]],
    ]) {
      expect(() => resolveHybridEvent(finalizeEvent({ ...plaintextTemplate, tags }, secret) as SignedNostrEvent))
        .toThrow(/scalar ox/u);
    }

    const encryptedTemplate = buildFileEvent(encryptedPublication, 2_000);
    for (const mutation of [
      { content: "private-plan.txt", tags: encryptedTemplate.tags },
      {
        content: encryptedTemplate.content,
        tags: encryptedTemplate.tags.map((tag) => tag[0] === "m" ? ["m", "text/plain"] : tag),
      },
      {
        content: encryptedTemplate.content,
        tags: encryptedTemplate.tags.map((tag) => tag[0] === "alt" ? ["alt", "Private plan"] : tag),
      },
      { content: encryptedTemplate.content, tags: encryptedTemplate.tags.filter((tag) => tag[0] !== "alt") },
    ]) {
      const signed = finalizeEvent({ ...encryptedTemplate, ...mutation }, secret) as SignedNostrEvent;
      expect(() => resolveHybridEvent(signed)).toThrow(/canonical public envelope metadata/u);
    }
  });

  it("refuses to build an encrypted event around non-canonical public metadata", () => {
    expect(() => buildFileEvent({ ...publication, encryption: WILDBLOOM_ENCRYPTION }, 2_000))
      .toThrow(/canonical public envelope/u);
  });
});

describe("Blossom descriptors", () => {
  it("accepts only the expected hash and size", () => {
    expect(validateBlobDescriptor(publication.descriptor, { sha256, size: 5 })).toEqual(publication.descriptor);
    expect(() => validateBlobDescriptor({ ...publication.descriptor, sha256: "00".repeat(32) }, { sha256, size: 5 }))
      .toThrow(/different bytes/u);
    expect(() => validateBlobDescriptor({ ...publication.descriptor, url: "http://cdn.example.com/blob" }, { sha256, size: 5 }))
      .toThrow();
    expect(() => validateBlobDescriptor({ ...publication.descriptor, type: "text/html" }, publication.inspected))
      .toThrow(/MIME/u);
  });
});
