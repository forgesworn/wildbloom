// Frozen envelopes made by the page's own encryptor (src/core/crypto.ts, through
// src/send/source.ts) with a key the receiver supplied. Browser to Rust is a new
// direction for Wildbloom: Drop (wildbloom-envelope) must open every case here
// with the same key and read the same name, type and bytes. The cases are the
// names and types a phone can produce that most easily go wrong: a name over 180
// units, emoji and combining marks, an empty type, an unusual legal type and a
// type too long to keep.
//
// The file is frozen, because the encryptor's salt and nonce are random. To make
// it again (and then have Drop's tests re-pin it):
//   WRITE_SEND_ENVELOPE_VECTOR=1 npx vitest run tests/send-envelope-vector.test.ts
import { createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decryptPrivacyEnvelope, encryptPrivacyEnvelope } from "../src/core/crypto.js";
import { prepareSource } from "../src/send/source.js";

const path = fileURLToPath(new URL("../test-vectors/fswnenc2-supplied-key.json", import.meta.url));

interface Case {
  name: string;
  inputKey: string;
  inputName: string;
  inputType: string;
  sourceUtf8: string;
  expected: { name: string; type: string; bytes: number };
  envelopeBytes: number;
  envelopeSha256: string;
  envelopeBase64: string;
}

interface Vector {
  description: string;
  cases: Case[];
}

const long = `${"long-name-".repeat(30)}.pdf`;
const INPUTS = [
  { name: "a name of 300 characters is cut to 180 units", inputName: long, inputType: "application/pdf", sourceUtf8: "pdf bytes, pretend\n" },
  { name: "emoji, a joined family and combining marks", inputName: "Holiday \u{1F3D6}️ \u{1F468}‍\u{1F469}‍\u{1F467} café.jpg", inputType: "image/jpeg", sourceUtf8: "café \u{1F3D6}️\n" },
  { name: "an empty type becomes the generic one", inputName: "no-type.bin", inputType: "", sourceUtf8: "untyped\n" },
  { name: "an unusual legal type with quotes and a backslash", inputName: "odd.bin", inputType: 'application/vnd.example+json; profile="a\\b"', sourceUtf8: "{\"odd\":true}\n" },
  { name: "a type over 255 characters falls back to the generic one", inputName: "huge-type.bin", inputType: `application/${"x".repeat(300)}`, sourceUtf8: "huge\n" },
];

const KEY = `wbk1_${Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index)).toString("base64url")}`;

async function generate(): Promise<Vector> {
  const cases: Case[] = [];
  for (const input of INPUTS) {
    const source = prepareSource(new File([input.sourceUtf8], input.inputName, { type: input.inputType }));
    const sealed = await encryptPrivacyEnvelope(source, { key: KEY });
    const bytes = Buffer.from(await sealed.file.arrayBuffer());
    cases.push({
      name: input.name,
      inputKey: KEY,
      inputName: input.inputName,
      inputType: input.inputType,
      sourceUtf8: input.sourceUtf8,
      expected: { name: sealed.sourceName, type: sealed.sourceType, bytes: Buffer.byteLength(input.sourceUtf8) },
      envelopeBytes: bytes.length,
      envelopeSha256: createHash("sha256").update(bytes).digest("hex"),
      envelopeBase64: bytes.toString("base64"),
    });
  }
  return {
    description: "FSWNENC2 envelopes made in the browser (src/core/crypto.ts encryptPrivacyEnvelope with a supplied key, after src/send/source.ts prepareSource). Frozen: salt and nonce were random when written. Every case must open with `inputKey` to `expected.name`, `expected.type` and the bytes of `sourceUtf8`, in the web page's decryptor and in Drop's wildbloom-envelope.",
    cases,
  };
}

if (process.env.WRITE_SEND_ENVELOPE_VECTOR === "1") writeFileSync(path, `${JSON.stringify(await generate(), null, 2)}\n`);

const vector = JSON.parse(readFileSync(path, "utf8")) as Vector;

/** An independent reader on Node's own crypto, as in fswnenc2.test.ts. */
function open(envelope: Buffer, inputKey: Buffer): { name: string; type: string; size: number; source: Buffer } {
  const salt = envelope.subarray(24, 56);
  const key = Buffer.from(hkdfSync("sha256", inputKey, salt, Buffer.from("forgesworn-aes-256-gcm-chunked/v2", "utf8"), 32));
  const chunk = envelope.readUInt32BE(8);
  const records = envelope.readUInt32BE(12);
  const header = envelope.subarray(0, 56);
  const parts: Buffer[] = [];
  let offset = 56;
  for (let counter = 0; counter < records; counter += 1) {
    const bodyLength = counter === records - 1 ? envelope.length - offset - 16 : chunk;
    const ciphertext = envelope.subarray(offset, offset + bodyLength);
    const tag = envelope.subarray(offset + bodyLength, offset + bodyLength + 16);
    offset += bodyLength + 16;
    const nonce = Buffer.alloc(12);
    envelope.subarray(16, 24).copy(nonce);
    nonce.writeUInt32BE(counter, 8);
    const aad = Buffer.alloc(60);
    header.copy(aad, 0);
    aad.writeUInt32BE(counter, 56);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    parts.push(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }
  const plaintext = Buffer.concat(parts);
  const length = plaintext.readUInt32BE(0);
  const metadataText = plaintext.subarray(4, 4 + length).toString("utf8");
  const metadata = JSON.parse(metadataText) as { name: string; size: number; type: string };
  // The canonical form Drop reads: this key order, nothing else, no extra spaces.
  expect(metadataText).toBe(JSON.stringify({ name: metadata.name, size: metadata.size, type: metadata.type }));
  return { ...metadata, source: Buffer.from(plaintext.subarray(4 + length, 4 + length + metadata.size)) };
}

describe("envelopes made in the browser with a supplied key", () => {
  it("covers the awkward names and types", () => {
    expect(vector.cases).toHaveLength(INPUTS.length);
    expect(vector.cases.map((entry) => entry.expected.type)).toContain("application/octet-stream");
  });

  it.each(vector.cases.map((entry) => [entry.name, entry] as const))("%s: is frozen as written", (_name, entry) => {
    const bytes = Buffer.from(entry.envelopeBase64, "base64");
    expect(bytes.length).toBe(entry.envelopeBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.envelopeSha256);
    expect(bytes.subarray(0, 8).toString("latin1")).toBe("FSWNENC2");
  });

  it.each(vector.cases.map((entry) => [entry.name, entry] as const))("%s: opens in the page's decryptor", async (_name, entry) => {
    const opened = await decryptPrivacyEnvelope(new Blob([Buffer.from(entry.envelopeBase64, "base64")]), entry.inputKey);
    expect(opened.name).toBe(entry.expected.name);
    expect(opened.type).toBe(entry.expected.type);
    expect(await opened.text()).toBe(entry.sourceUtf8);
  });

  it.each(vector.cases.map((entry) => [entry.name, entry] as const))("%s: opens in an independent reader", (_name, entry) => {
    const inputKey = Buffer.from(entry.inputKey.slice("wbk1_".length), "base64url");
    const opened = open(Buffer.from(entry.envelopeBase64, "base64"), inputKey);
    expect(opened.name).toBe(entry.expected.name);
    expect(opened.type).toBe(entry.expected.type);
    expect(opened.size).toBe(entry.expected.bytes);
    expect(opened.source.toString("utf8")).toBe(entry.sourceUtf8);
  });

  it("keeps the name within 180 UTF-16 units and the type within 255, the bounds Drop reads", () => {
    for (const entry of vector.cases) {
      expect(entry.expected.name.length).toBeLessThanOrEqual(180);
      expect(entry.expected.type.length).toBeLessThanOrEqual(255);
    }
    expect(vector.cases[0]!.expected.name).toHaveLength(180);
  });
});
