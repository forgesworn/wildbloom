import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBlossomUri, fetchVerifiedBlob, inspectFile, uploadToBlossom } from "../src/core/blossom.js";
import type { ResolvedHybridEvent, SignerPort } from "../src/core/types.js";

const secret = new Uint8Array(32).fill(9);
const pubkey = getPublicKey(secret);
const signer: SignerPort = {
  async getPublicKey() { return pubkey; },
  async signEvent(template) { return finalizeEvent(template, secret); },
};

afterEach(() => vi.useRealTimers());

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
    await uploadToBlossom(inspected, "https://cdn.example.com", signer, pubkey, { fetchImpl: fetchMock });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("X-SHA-256")).toBe(inspected.sha256);
    const authorization = new Headers(init.headers).get("Authorization") ?? "";
    expect(authorization).toMatch(/^Nostr /u);
    const encoded = authorization.slice("Nostr ".length);
    // BUD-01: standard base64, not url-safe. No -/_ alphabet, padded to a multiple of four,
    // and it round-trips to the kind 24242 event.
    expect(encoded).not.toMatch(/[-_]/u);
    expect(encoded.length % 4).toBe(0);
    expect(JSON.parse(atob(encoded))).toMatchObject({ kind: 24242 });
    expect(init.redirect).toBe("error");
  });

  it("allows a bounded five-minute authority for deliberate external signing", async () => {
    const inspected = await inspectFile(new File(["hello"], "hello.txt", { type: "text/plain" }));
    const signEvent = vi.fn(signer.signEvent);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      url: `https://cdn.example.com/${inspected.sha256}.txt`,
      sha256: inspected.sha256,
      size: inspected.size,
      type: inspected.type,
      uploaded: 123,
    }), { status: 201 }));
    await uploadToBlossom(inspected, "https://cdn.example.com", { ...signer, signEvent }, pubkey, {
      fetchImpl: fetchMock,
      authorisationLifetimeSeconds: 300,
    });
    const template = signEvent.mock.calls[0]?.[0];
    expect(Number(template?.tags.find((tag) => tag[0] === "expiration")?.[1]) - Number(template?.created_at)).toBe(300);
  });

  it("caps a streamed descriptor before parsing attacker-controlled JSON", async () => {
    const inspected = await inspectFile(new File(["hello"], "hello.txt", { type: "text/plain" }));
    const response = new Response(`{"padding":"${"x".repeat(70 * 1024)}"}`, { status: 201 });
    await expect(uploadToBlossom(
      inspected,
      "https://cdn.example.com",
      signer,
      pubkey,
      { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) },
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
      { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) },
    )).rejects.toThrow(/unapproved origin/u);
  });

  it("aborts a hung upload at its explicit safety deadline", async () => {
    vi.useFakeTimers();
    const inspected = await inspectFile(new File(["hello"], "hello.txt", { type: "text/plain" }));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => undefined));
    const result = uploadToBlossom(inspected, "https://cdn.example.com", signer, pubkey, {
      fetchImpl: fetchMock,
      timeoutMs: 25,
    });
    const assertion = expect(result).rejects.toThrow("Blossom upload timed out.");
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it("does not invoke a signer or fetch after upload authority is already cancelled", async () => {
    const inspected = await inspectFile(new File(["hello"], "hello.txt", { type: "text/plain" }));
    const signEvent = vi.fn(signer.signEvent);
    const fetchMock = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(uploadToBlossom(
      inspected,
      "https://cdn.example.com",
      { ...signer, signEvent },
      pubkey,
      { fetchImpl: fetchMock, signal: controller.signal },
    )).rejects.toThrow(/cancelled/u);
    expect(signEvent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
    const blob = await fetchVerifiedBlob(resolved, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(await blob.text()).toBe("hello");
  });

  it("rejects a lying content length before accepting bytes", async () => {
    const hash = "ab".repeat(32);
    const resolved = {
      url: `https://cdn.example.com/${hash}.bin`, sha256: hash, size: 5, mimeType: "application/octet-stream",
    } as ResolvedHybridEvent;
    const response = new Response("hello", { status: 200, headers: { "Content-Length": "6" } });
    Object.defineProperty(response, "url", { value: resolved.url });
    await expect(fetchVerifiedBlob(resolved, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) })).rejects.toThrow(/byte count/u);
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
    await expect(fetchVerifiedBlob(resolved, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) })).rejects.toThrow(/changed URL/u);
  });

  it("aborts retrieval when the user cancels", async () => {
    const hash = "ab".repeat(32);
    const resolved = {
      url: `https://cdn.example.com/${hash}.bin`, sha256: hash, size: 5, mimeType: "application/octet-stream",
    } as ResolvedHybridEvent;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const result = fetchVerifiedBlob(resolved, { fetchImpl: fetchMock, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow("Blossom retrieval cancelled.");
  });

  it("bounds retrieval even when the fetch implementation ignores abort", async () => {
    vi.useFakeTimers();
    const hash = "ab".repeat(32);
    const resolved = {
      url: `https://cdn.example.com/${hash}.bin`, sha256: hash, size: 5, mimeType: "application/octet-stream",
    } as ResolvedHybridEvent;
    const result = fetchVerifiedBlob(resolved, {
      fetchImpl: vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => undefined)),
      timeoutMs: 25,
    });
    const assertion = expect(result).rejects.toThrow("Blossom retrieval timed out.");
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it("does not invoke fetch when retrieval was cancelled before it began", async () => {
    const hash = "ab".repeat(32);
    const resolved = {
      url: `https://cdn.example.com/${hash}.bin`, sha256: hash, size: 5, mimeType: "application/octet-stream",
    } as ResolvedHybridEvent;
    const fetchMock = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(fetchVerifiedBlob(resolved, { fetchImpl: fetchMock, signal: controller.signal }))
      .rejects.toThrow(/cancelled/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
