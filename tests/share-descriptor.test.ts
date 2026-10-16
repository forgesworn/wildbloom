import { describe, expect, it, vi } from "vitest";
import {
  BlossomRetrievalError,
  fetchVerifiedShare,
  parseShareDescriptor,
  ShareDescriptorError,
  SHARE_DESCRIPTOR_MAX_BYTES,
} from "../src/core/blossom.js";
import { sha256Hex } from "../src/core/crypto.js";
import { MAX_PROTOTYPE_FILE_BYTES, MAX_PROTOTYPE_TRANSFER_BYTES } from "../src/core/security.js";

const hash = "ab".repeat(32);
const key = `wbk1_${"A".repeat(43)}`;

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: "wildbloom-share/1",
    url: `https://storage.example/${hash}`,
    sha256: hash,
    size: 65_608,
    key,
    name: "holiday-photos.zip",
    bytes: 43,
    expires: 1_900_000_000,
    ...overrides,
  };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function reason(value: unknown): string | undefined {
  try {
    parseShareDescriptor(encode(value));
  } catch (error) {
    return error instanceof ShareDescriptorError ? error.reason : "other";
  }
  return undefined;
}

describe("share descriptor validation", () => {
  it("accepts the exact documented shape and freezes the result", () => {
    const parsed = parseShareDescriptor(encode(descriptor()));
    expect(parsed).toMatchObject({ name: "holiday-photos.zip", bytes: 43, size: 65_608, sha256: hash });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("accepts plain HTTP only for loopback development", () => {
    expect(reason(descriptor({ url: `http://127.0.0.1:9000/${hash}` }))).toBeUndefined();
    expect(reason(descriptor({ url: `http://storage.example/${hash}` }))).toBe("invalid");
  });

  it.each([
    ["an extra field", { extra: 1 }],
    ["a wrong version", { v: "wildbloom-share/2" }],
    ["an upper-case hash", { sha256: hash.toUpperCase() }],
    ["a short hash", { sha256: "ab" }],
    ["a URL that does not end in the hash", { url: `https://storage.example/${"cd".repeat(32)}` }],
    ["a URL with a file extension", { url: `https://storage.example/${hash}.bin` }],
    ["a URL with a query", { url: `https://storage.example/${hash}?token=1` }],
    ["a URL with a fragment", { url: `https://storage.example/${hash}#x` }],
    ["a URL with credentials", { url: `https://user:pass@storage.example/${hash}` }],
    ["a non-canonical URL", { url: `HTTPS://Storage.Example/${hash}` }],
    ["an onion address under the direct profile", { url: `https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion/${hash}` }],
    ["a key without the prefix", { key: "A".repeat(48) }],
    ["a short key", { key: "wbk1_short" }],
    ["an empty name", { name: "" }],
    ["a name with a path", { name: "../secret.txt" }],
    ["an unsanitised name", { name: "bad:name?.txt" }],
    ["a zero size", { size: 0 }],
    ["a fractional size", { size: 1.5 }],
    ["a string size", { size: "10" }],
    ["a zero plaintext size", { bytes: 0 }],
    ["a missing expiry", { expires: 0 }],
    ["a string expiry", { expires: "soon" }],
  ])("rejects %s", (_label, overrides) => {
    expect(reason(descriptor(overrides))).toBe("invalid");
  });

  it("rejects arrays, scalars, malformed JSON and invalid UTF-8", () => {
    expect(reason([])).toBe("invalid");
    expect(reason("text")).toBe("invalid");
    expect(reason(null)).toBe("invalid");
    expect(() => parseShareDescriptor(new TextEncoder().encode("{not json"))).toThrow(ShareDescriptorError);
    expect(() => parseShareDescriptor(new Uint8Array([0xff, 0xfe]))).toThrow(ShareDescriptorError);
    expect(() => parseShareDescriptor(new Uint8Array(0))).toThrow(ShareDescriptorError);
  });

  it("rejects a payload over the pairing frame limit before parsing it", () => {
    expect(() => parseShareDescriptor(new Uint8Array(SHARE_DESCRIPTOR_MAX_BYTES + 1).fill(0x20))).toThrow(/unexpected size/u);
  });

  it("reports an oversize share separately from a malformed one", () => {
    expect(reason(descriptor({ size: MAX_PROTOTYPE_TRANSFER_BYTES + 1 }))).toBe("too-large");
    expect(reason(descriptor({ bytes: MAX_PROTOTYPE_FILE_BYTES + 1 }))).toBe("too-large");
    expect(reason(descriptor({ size: MAX_PROTOTYPE_TRANSFER_BYTES, bytes: MAX_PROTOTYPE_FILE_BYTES }))).toBeUndefined();
  });
});

describe("verified share retrieval", () => {
  async function share(text: string) {
    const bytes = new TextEncoder().encode(text);
    const sha256 = await sha256Hex(new Blob([bytes]));
    const parsed = parseShareDescriptor(encode(descriptor({ sha256, url: `https://storage.example/${sha256}`, size: bytes.byteLength })));
    return { bytes, parsed };
  }

  it("maps the descriptor onto the verified path and keeps every request guard", async () => {
    const { bytes, parsed } = await share("ciphertext bytes");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, { headers: { "Content-Length": String(bytes.byteLength) } }));
    const blob = await fetchVerifiedShare(parsed, { fetchImpl: fetchMock });
    expect(await blob.text()).toBe("ciphertext bytes");
    expect(blob.type).toBe("application/vnd.forgesworn.encrypted");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(parsed.url, expect.objectContaining({
      method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
    }));
  });

  it("reports running progress against the declared size", async () => {
    const { bytes, parsed } = await share("progress counts");
    const half = Math.floor(bytes.byteLength / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, half));
        controller.enqueue(bytes.slice(half));
        controller.close();
      },
    });
    const seen: Array<[number, number]> = [];
    await fetchVerifiedShare(parsed, {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
      onProgress: (received, total) => seen.push([received, total]),
    });
    expect(seen).toEqual([[half, bytes.byteLength], [bytes.byteLength, bytes.byteLength]]);
  });

  it("tells a missing object from an unreachable server by status", async () => {
    const { parsed } = await share("missing");
    const missing = await fetchVerifiedShare(parsed, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })) }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(BlossomRetrievalError);
    expect(missing).toMatchObject({ kind: "http", status: 404 });
    const down = await fetchVerifiedShare(parsed, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })) }).catch((error: unknown) => error);
    expect(down).toMatchObject({ kind: "http", status: 503 });
  });

  it("rejects changed bytes of the right size as an integrity failure", async () => {
    const { bytes, parsed } = await share("untampered!!");
    const tampered = bytes.slice();
    tampered[3] = (tampered[3] ?? 0) ^ 1;
    const error = await fetchVerifiedShare(parsed, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(tampered)) }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "integrity" });
    expect((error as Error).message).toMatch(/SHA-256/u);
  });

  it("rejects short and long bodies and a lying Content-Length", async () => {
    const { bytes, parsed } = await share("exact length");
    const cases: Array<[Response, RegExp]> = [
      [new Response(bytes.slice(0, -1)), /fewer bytes/u],
      [new Response(new Uint8Array([...bytes, 1])), /more bytes/u],
      [new Response(bytes, { headers: { "Content-Length": String(bytes.byteLength + 1) } }), /byte count/u],
    ];
    for (const [response, pattern] of cases) {
      const error = await fetchVerifiedShare(parsed, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind: "integrity" });
      expect((error as Error).message).toMatch(pattern);
    }
  });

  it("refuses a redirect to another address", async () => {
    const { bytes, parsed } = await share("no redirects");
    const response = new Response(bytes);
    Object.defineProperty(response, "url", { value: `https://elsewhere.example/${parsed.sha256}` });
    await expect(fetchVerifiedShare(parsed, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) })).rejects.toThrow(/changed URL/u);
  });
});
