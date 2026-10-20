// Shared vectors for wildbloom-direct/1, copied unedited from the protocol work:
//   source repository  forgesworn/wildbloom-node, branch docs/direct-send-protocol
//   source commit      fba5bbb43974582a9a2e10dbd6b559c4f4d7729a
//   source path        vectors/wildbloom-direct-v1.json
//   copied to          test-vectors/wildbloom-direct-v1.json (never edit it; copy it again)
// The protocol text is docs/PROTOCOL.md, section "Direct send", on the same branch.
// The SHA-256 below pins the copy. Servers, credentials and keys in it are synthetic.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DIRECT_ICE_URLS, parseIceAllowlist } from "../src/direct/config.js";
import { canonicalJson, checkSdp, decodeMessage, encodeMessage, type DirectMessage, type Side } from "../src/direct/messages.js";

const VECTOR_SHA256 = "7f80cd7fddf17f79ed639e1789e4e45a428090c355227eb706e0606f7cee4a1f";
const raw = readFileSync(new URL("../test-vectors/wildbloom-direct-v1.json", import.meta.url));

interface Vectors {
  iceAllowlist: string[];
  limits: Record<string, number>;
  messages: { name: string; from: Side; index: number; text: string; sha256: string }[];
  refusals: { name: string; from: Side; index: number; text: string; stopReason: "failed" | "unsupported" }[];
}
const vectors = JSON.parse(raw.toString("utf8")) as Vectors;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const context = (from: Side, index: number) => ({ from, index, iceAllowlist: vectors.iceAllowlist, max: 250_000_000 });

describe("the shared direct send vectors", () => {
  it("are the copy the protocol branch published", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(VECTOR_SHA256);
  });

  it("carry the limits this module implements", () => {
    expect(vectors.limits).toMatchObject({
      messageBytes: 16_379,
      messagesPerSide: 8,
      restarts: 5,
      sdpBytes: 8_000,
      maxPlaintextBytes: 250_000_000,
    });
  });
});

describe("message decoding", () => {
  it.each(vectors.messages.map((entry) => [entry.name, entry] as const))("accepts %s and writes it back byte for byte", (_name, entry) => {
    expect(createHash("sha256").update(entry.text).digest("hex")).toBe(entry.sha256);
    const result = decodeMessage(bytes(entry.text), context(entry.from, entry.index));
    if (!result.ok) throw new Error(`refused: ${result.detail}`);
    expect(new TextDecoder().decode(encodeMessage(result.message))).toBe(entry.text);
  });

  it.each(vectors.refusals.map((entry) => [entry.name, entry] as const))("refuses %s with the reason the vector names", (_name, entry) => {
    const result = decodeMessage(bytes(entry.text), context(entry.from, entry.index));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stop).toBe(entry.stopReason);
  });

  it("refuses a byte order mark, bytes that are not UTF-8 and an over-long message", () => {
    const stop = '{"event":"stop","reason":"cancelled","v":1}';
    expect(decodeMessage(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(stop)]), context("page", 3)).ok).toBe(false);
    expect(decodeMessage(new Uint8Array([0x7b, 0xff, 0x7d]), context("page", 3)).ok).toBe(false);
    expect(decodeMessage(new Uint8Array(16_380).fill(0x20), context("page", 3)).ok).toBe(false);
    expect(decodeMessage(bytes(stop), context("page", 3)).ok).toBe(true);
  });

  it("allows stop in place of any message but Drop's first, and nothing past index 7", () => {
    const stop = bytes('{"event":"stop","reason":"failed","v":1}');
    for (const index of [0, 1, 2, 6, 7]) {
      expect(decodeMessage(stop, context("page", index)).ok).toBe(true);
      expect(decodeMessage(stop, context("drop", index)).ok).toBe(index !== 0);
    }
    expect(decodeMessage(stop, context("page", 8)).ok).toBe(false);
    expect(decodeMessage(stop, context("drop", -1)).ok).toBe(false);
  });

  it("lets Drop ask for ICE restarts at indexes 2 to 6 only", () => {
    const restart = vectors.messages.find((entry) => entry.name === "restart")!;
    for (const index of [2, 3, 4, 5, 6]) expect(decodeMessage(bytes(restart.text), context("drop", index)).ok).toBe(true);
    for (const index of [0, 1, 7]) expect(decodeMessage(bytes(restart.text), context("drop", index)).ok).toBe(false);
    expect(decodeMessage(bytes(restart.text), context("page", 2)).ok).toBe(false);
  });

  it("does not check a manifest against a maximum it has not been given", () => {
    const manifest = bytes('{"event":"manifest","name":"a.bin","size":500000000,"type":"application/octet-stream","v":1}');
    expect(decodeMessage(manifest, { from: "page", index: 0, iceAllowlist: [] }).ok).toBe(true);
    expect(decodeMessage(manifest, context("page", 0))).toMatchObject({ ok: false, stop: "unsupported" });
  });
});

describe("canonical writing", () => {
  it("orders members at every depth and writes strings as JSON.stringify does", () => {
    expect(canonicalJson({ b: [{ z: 1, a: true }], a: "é/\u0001\n\"\\\u007f" })).toBe('{"a":"é/\\u0001\\n\\"\\\\\u007f","b":[{"a":true,"z":1}]}');
  });

  it.each([[null], [-1], [1.5], [2 ** 53], [Number.NaN], ["\ud800"], [undefined], [{ a: null }], [-0]])("refuses %j", (value) => {
    expect(() => canonicalJson(value)).toThrow();
  });

  it("will not write a message larger than the exchange allows", () => {
    const message: DirectMessage = { event: "accept", sdp: "v=0\r\n".padEnd(16_380, "a") };
    expect(() => encodeMessage(message)).toThrow(RangeError);
  });
});

describe("session description checks", () => {
  const good = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\n";
  it("accepts the smallest description with one data-channel section and a SHA-256 fingerprint", () => {
    expect(checkSdp(good)).toBeUndefined();
  });
  it.each([
    ["no trailing CRLF", good.slice(0, -2)],
    ["a lone carriage return", good.replace("v=0\r\n", "v=0\r\r\n")],
    ["a non-ASCII byte", good.replace("AA:BB", "AA:Bé")],
    ["a tab", good.replace("AA:BB", "AA:\tBB")],
    ["a SHA-1 fingerprint", good.replace("sha-256", "sha-1")],
    ["a second m= line", `${good}m=audio 9 RTP/AVP 0\r\n`],
    ["the wrong protocol", good.replace("UDP/DTLS/SCTP webrtc-datachannel", "RTP/AVP 0")],
    ["an empty description", ""],
  ])("refuses %s", (_name, sdp) => {
    expect(checkSdp(sdp)).toBeTypeOf("string");
  });
});

describe("the build-time ICE allowlist", () => {
  it("defaults to the owner's coturn, with a TURN URL", () => {
    expect(DEFAULT_DIRECT_ICE_URLS.some((url) => url.startsWith("turn:"))).toBe(true);
    expect(DEFAULT_DIRECT_ICE_URLS.every((url) => /^(?:stun|turn|turns):kithmoot\.forgesworn\.dev:\d+/u.test(url))).toBe(true);
    expect(parseIceAllowlist(undefined)).toBe(DEFAULT_DIRECT_ICE_URLS);
    expect(parseIceAllowlist("  ")).toBe(DEFAULT_DIRECT_ICE_URLS);
  });

  it("reads a comma-separated override exactly and drops repeats", () => {
    expect(parseIceAllowlist("stun:a.example:3478, turn:a.example:3478?transport=udp,turn:a.example:3478?transport=udp")).toEqual([
      "stun:a.example:3478",
      "turn:a.example:3478?transport=udp",
    ]);
  });

  it.each([
    ["a URL with another scheme", "https://a.example,turn:a.example:3478"],
    ["a blank entry", "turn:a.example:3478,,stun:a.example:3478"],
    ["no TURN URL", "stun:a.example:3478"],
    ["an over-long URL", `turn:${"a".repeat(300)}:3478`],
  ])("stops the page loading on %s", (_name, value) => {
    expect(() => parseIceAllowlist(value)).toThrow();
  });
});
