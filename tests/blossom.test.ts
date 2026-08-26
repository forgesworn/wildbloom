import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";
import { buildBlossomUri, fetchVerifiedBlob, inspectFile, uploadToBlossom } from "../src/core/blossom.js";
import type { ResolvedHybridEvent, SignerPort } from "../src/core/types.js";

const secret = new Uint8Array(32).fill(9);
const pubkey = getPublicKey(secret);
const signer: SignerPort = {
  async getPublicKey() { return pubkey; },
  async signEvent(template) { return finalizeEvent(template, secret); },
};

describe("Blossom publication", () => {
  it("builds BUD-10 references and scoped upload requests", async () => {
    const inspected = await inspectFile(new File(["hello"], "hello.txt", { type: "text/plain" }));
    expect(buildBlossomUri(inspected, "https://cdn.example.com", pubkey)).toContain(`blossom:${inspected.sha256}.txt?`);

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      url: `https://cdn.example.com/${inspected.sha256}.txt`,
      sha256: inspected.sha256,
      size: inspected.size,
      type: inspected.type,
      uploaded: 123,
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    await uploadToBlossom(inspected, "https://cdn.example.com", signer, pubkey, fetchMock);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("X-SHA-256")).toBe(inspected.sha256);
    expect(new Headers(init.headers).get("Authorization")).toMatch(/^Nostr /u);
    expect(init.redirect).toBe("error");
  });

  it("caps a streamed descriptor before parsing attacker-controlled JSON", async () => {
    const inspected = await inspectFile(new File(["hello"], "hello.txt", { type: "text/plain" }));
    const response = new Response(`{"padding":"${"x".repeat(70 * 1024)}"}`, { status: 201 });
    await expect(uploadToBlossom(
      inspected,
      "https://cdn.example.com",
      signer,
      pubkey,
      vi.fn<typeof fetch>().mockResolvedValue(response),
    )).rejects.toThrow(/unexpectedly large/u);
  });

  it("rejects a descriptor that moves the signed payload to another origin", async () => {
    const inspected = await inspectFile(new File(["hello"], "hello.txt", { type: "text/plain" }));
    const response = new Response(JSON.stringify({
      url: `https://other.example.com/${inspected.sha256}.txt`,
      sha256: inspected.sha256,
      size: inspected.size,
      type: inspected.type,
      uploaded: 123,
    }), { status: 201 });
    await expect(uploadToBlossom(
      inspected,
      "https://cdn.example.com",
      signer,
      pubkey,
      vi.fn<typeof fetch>().mockResolvedValue(response),
    )).rejects.toThrow(/unapproved origin/u);
  });
});

describe("verified Blossom retrieval", () => {
  it("returns only bytes matching the signed size and SHA-256", async () => {
    const bytes = new TextEncoder().encode("hello");
    const inspected = await inspectFile(new File([bytes], "hello.txt", { type: "text/plain" }));
    const resolved = {
      url: `https://cdn.example.com/${inspected.sha256}.txt`,
      sha256: inspected.sha256,
      size: bytes.byteLength,
      mimeType: "text/plain",
    } as ResolvedHybridEvent;
    const response = new Response(bytes, { status: 200, headers: { "Content-Length": String(bytes.byteLength) } });
    Object.defineProperty(response, "url", { value: resolved.url });
    const blob = await fetchVerifiedBlob(resolved, vi.fn<typeof fetch>().mockResolvedValue(response));
    expect(await blob.text()).toBe("hello");
  });

  it("rejects a lying content length before accepting bytes", async () => {
    const hash = "ab".repeat(32);
    const resolved = {
      url: `https://cdn.example.com/${hash}.bin`, sha256: hash, size: 5, mimeType: "application/octet-stream",
    } as ResolvedHybridEvent;
    const response = new Response("hello", { status: 200, headers: { "Content-Length": "6" } });
    Object.defineProperty(response, "url", { value: resolved.url });
    await expect(fetchVerifiedBlob(resolved, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow(/byte count/u);
  });

  it("rejects a redirect even if the new path repeats the signed hash", async () => {
    const bytes = new TextEncoder().encode("hello");
    const inspected = await inspectFile(new File([bytes], "hello.txt", { type: "text/plain" }));
    const resolved = {
      url: `https://cdn.example.com/${inspected.sha256}.txt`,
      sha256: inspected.sha256,
      size: bytes.byteLength,
      mimeType: "text/plain",
    } as ResolvedHybridEvent;
    const response = new Response(bytes, { status: 200, headers: { "Content-Length": String(bytes.byteLength) } });
    Object.defineProperty(response, "url", { value: `https://redirect.example.com/${inspected.sha256}.txt` });
    await expect(fetchVerifiedBlob(resolved, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow(/changed URL/u);
  });
});
