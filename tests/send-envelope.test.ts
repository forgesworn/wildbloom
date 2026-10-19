import { describe, expect, it } from "vitest";
import { decryptPrivacyEnvelope, encryptPrivacyEnvelope, envelopeBytes, parseInputKey, sha256Hex } from "../src/core/crypto.js";
import { prepareSource, safeMediaType, wellFormed } from "../src/send/source.js";

const KEY = `wbk1_${Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 33)).toString("base64url")}`;
const OTHER_KEY = `wbk1_${Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => 200 - index)).toString("base64url")}`;

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

describe("encryption with a supplied key", () => {
  it("returns the supplied key, and the envelope opens with it through the existing decryptor", async () => {
    const source = new File([bytes("a photo, but smaller")], "holiday.jpg", { type: "image/jpeg" });
    const sealed = await encryptPrivacyEnvelope(source, { key: KEY });
    expect(sealed.recoveryKey).toBe(KEY);
    expect(sealed.scheme).toBe("forgesworn-aes-256-gcm-chunked-v2");
    const opened = await decryptPrivacyEnvelope(sealed.file, KEY);
    expect(opened.name).toBe("holiday.jpg");
    expect(opened.type).toBe("image/jpeg");
    expect(new Uint8Array(await opened.arrayBuffer())).toEqual(bytes("a photo, but smaller"));
  });

  it("does not open with another key", async () => {
    const sealed = await encryptPrivacyEnvelope(new File(["secret"], "secret.txt"), { key: KEY });
    await expect(decryptPrivacyEnvelope(sealed.file, OTHER_KEY)).rejects.toThrow(/recovery key is wrong/u);
  });

  it("still derives a different AES key for every envelope, so one key can be used twice safely", async () => {
    const source = new File(["same bytes"], "same.txt");
    const first = await encryptPrivacyEnvelope(source, { key: KEY });
    const second = await encryptPrivacyEnvelope(source, { key: KEY });
    expect(first.recoveryKey).toBe(second.recoveryKey);
    expect(await sha256Hex(first.file)).not.toBe(await sha256Hex(second.file));
    const header = (blob: Blob): Promise<Uint8Array> => blob.slice(0, 56).arrayBuffer().then((buffer) => new Uint8Array(buffer));
    const [a, b] = await Promise.all([header(first.file), header(second.file)]);
    expect(a!.slice(24, 56)).not.toEqual(b!.slice(24, 56));
  });

  it("keeps the old forms working: no options, an abort signal, and empty options all make a fresh key", async () => {
    const a = await encryptPrivacyEnvelope(new File(["x"], "x.txt"));
    const b = await encryptPrivacyEnvelope(new File(["x"], "x.txt"), new AbortController().signal);
    const c = await encryptPrivacyEnvelope(new File(["x"], "x.txt"), {});
    expect(new Set([a.recoveryKey, b.recoveryKey, c.recoveryKey]).size).toBe(3);
    for (const sealed of [a, b, c]) expect(sealed.recoveryKey).toMatch(/^wbk1_[A-Za-z0-9_-]{43}$/u);
  });

  it("honours an abort signal given in the options", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(encryptPrivacyEnvelope(new File(["x"], "x.txt"), { key: KEY, signal: controller.signal })).rejects.toThrow(/cancelled/u);
  });

  it.each([
    ["no prefix", KEY.slice(5)],
    ["too short", "wbk1_short"],
    ["too long", `${KEY}A`],
    ["padded", `${KEY.slice(0, -1)}=`],
    ["not canonical", `wbk1_${"A".repeat(42)}B`],
    ["standard base64 characters", `wbk1_${"+".repeat(43)}`],
    ["empty", ""],
  ])("refuses a key that is %s before it does any work", async (_name, key) => {
    await expect(encryptPrivacyEnvelope(new File(["x"], "x.txt"), { key })).rejects.toThrow(/recovery key|base64url|256 bits/u);
  });

  it("decodes a canonical key to 32 bytes and refuses the rest", () => {
    expect(parseInputKey(KEY)).toHaveLength(32);
    expect(() => parseInputKey(`wbk1_${"A".repeat(43)}`)).not.toThrow();
    expect(() => parseInputKey(`wbk1_${"A".repeat(42)}B`)).toThrow();
  });
});

describe("the size an envelope will have", () => {
  it.each([1, 100, 65_000, 65_536, 65_540, 600_000, 1_048_000, 1_048_576, 3 * 1024 * 1024 + 17])("is exact for %d bytes", async (size) => {
    const source = new File([new Uint8Array(size).fill(9)], "sized.bin", { type: "application/octet-stream" });
    const sealed = await encryptPrivacyEnvelope(source, { key: KEY });
    expect(envelopeBytes("sized.bin", "application/octet-stream", size)).toBe(sealed.file.size);
  });

  it("counts the name and type, which sit in the first record", () => {
    // Near the edge of the smallest bucket, a long name tips the first record into the next one.
    expect(envelopeBytes("a".repeat(180), "text/plain", 65_400)).toBeGreaterThan(envelopeBytes("a", "text/plain", 65_400));
    expect(() => envelopeBytes("x", "text/plain", 0)).toThrow(/non-empty/u);
  });

  it("fits the smallest and largest envelopes the protocol names", () => {
    expect(envelopeBytes("a", "a/b", 1)).toBe(65_608);
    // 250,000,000 plaintext bytes with a long name stays inside the largest allowed envelope.
    expect(envelopeBytes("a".repeat(180), "a".repeat(255), 250_000_000)).toBeLessThanOrEqual(270_532_608);
  });
});

describe("names and types a phone can produce", () => {
  const name300 = `${"long-name-".repeat(30)}.pdf`;
  const cases: { label: string; name: string; type: string; expectedName: string; expectedType: string }[] = [
    { label: "a 300-character name", name: name300, type: "application/pdf", expectedName: name300.slice(0, 180), expectedType: "application/pdf" },
    { label: "an emoji name", name: "Holiday \u{1F3D6}\uFE0F 2026 \u{1F468}\u200D\u{1F469}\u200D\u{1F467}.jpg", type: "image/jpeg", expectedName: "Holiday \u{1F3D6}\uFE0F 2026 \u{1F468}\u200D\u{1F469}\u200D\u{1F467}.jpg", expectedType: "image/jpeg" },
    { label: "combining marks that compose", name: "cafe\u0301 re\u0301sume\u0301.txt", type: "text/plain", expectedName: "caf\u00e9 r\u00e9sum\u00e9.txt", expectedType: "text/plain" },
    { label: "an empty type", name: "no-type.bin", type: "", expectedName: "no-type.bin", expectedType: "application/octet-stream" },
    { label: "an upper-case type", name: "shout.txt", type: "TEXT/Plain; Charset=UTF-8", expectedName: "shout.txt", expectedType: "text/plain; charset=utf-8" },
    { label: "a type over 255 characters", name: "huge-type.bin", type: `application/${"x".repeat(300)}`, expectedName: "huge-type.bin", expectedType: "application/octet-stream" },
    { label: "a type with a control character", name: "control.bin", type: "text/plain\u0007", expectedName: "control.bin", expectedType: "application/octet-stream" },
    { label: "a type outside ASCII", name: "greek.bin", type: "application/\u03A3\u03A3", expectedName: "greek.bin", expectedType: "application/octet-stream" },
    { label: "a path and awkward punctuation in the name", name: "C:\\Users\\me\\<bad>:name?.txt", expectedName: "_bad__name_.txt", type: "text/plain", expectedType: "text/plain" },
    { label: "a name of dots and spaces", name: " . . ", type: "text/plain", expectedName: "blob.bin", expectedType: "text/plain" },
    { label: "a lone surrogate in the name", name: "half\uD83Dname.txt", type: "text/plain", expectedName: "half\uFFFDname.txt", expectedType: "text/plain" },
    { label: "an unusual but legal type", name: "odd.bin", type: "application/vnd.example+json; profile=\"a\\b\"", expectedName: "odd.bin", expectedType: "application/vnd.example+json; profile=\"a\\b\"" },
  ];

  it.each(cases)("round-trips $label", async ({ name, type, expectedName, expectedType }) => {
    const source = prepareSource(new File([bytes("payload")], name, { type }));
    const sealed = await encryptPrivacyEnvelope(source, { key: KEY });
    expect(envelopeBytes(source.name, source.type, source.size)).toBe(sealed.file.size);
    const opened = await decryptPrivacyEnvelope(sealed.file, KEY);
    expect(opened.name).toBe(expectedName);
    expect(opened.type).toBe(expectedType);
    expect(new Uint8Array(await opened.arrayBuffer())).toEqual(bytes("payload"));
  });

  it("writes metadata that is already a fixed point, as Drop requires", async () => {
    for (const { name, type } of cases) {
      const once = prepareSource(new File(["x"], name, { type }));
      const twice = prepareSource(once);
      expect(twice.name).toBe(once.name);
      expect(twice.type).toBe(once.type);
    }
  });

  it("repairs a lone surrogate the way Rust's UTF-8 handling does, and nothing else", () => {
    expect(wellFormed("ok \u{1F600} fine")).toBe("ok \u{1F600} fine");
    expect(wellFormed("\uDC00a\uD800")).toBe("\uFFFDa\uFFFD");
  });

  it("falls back to the generic type for anything it cannot trust to round-trip", () => {
    expect(safeMediaType("")).toBe("application/octet-stream");
    expect(safeMediaType("Image/PNG")).toBe("image/png");
    expect(safeMediaType("image/\u00e9")).toBe("application/octet-stream");
    expect(safeMediaType("x".repeat(256))).toBe("application/octet-stream");
    expect(safeMediaType("x".repeat(255))).toBe("x".repeat(255));
  });

  it("does not copy the file's bytes to rename it", async () => {
    const original = new File([bytes("same")], "a.txt", { type: "text/plain" });
    const prepared = prepareSource(original);
    expect(prepared.size).toBe(original.size);
    expect(new Uint8Array(await prepared.arrayBuffer())).toEqual(bytes("same"));
  });
});
