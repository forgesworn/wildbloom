import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createEnvelopeEncoder,
  decryptPrivacyEnvelope,
  encryptPrivacyEnvelope,
  envelopeBytes,
  newInputKey,
  parseInputKey,
  type EnvelopeEncoder,
  type EnvelopeEntropy,
} from "../src/core/crypto.js";

const readJson = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../test-vectors/${name}`, import.meta.url)), "utf8"));

interface KnownAnswer {
  testOnlyInputKeyHex: string;
  saltHex: string;
  noncePrefixHex: string;
  headerHex: string;
  source: { utf8: string; name: string; type: string; bytes: number; sha256: string };
  envelopeBytes: number;
  envelopeSha256: string;
  envelopeBase64: string;
}
interface Direct {
  envelopes: { name: string; type: string; size: number; metadataBytes: number; paddedBytes: number; records: number; envelopeBytes: number }[];
}
const knownAnswer = readJson("fswnenc2-per-file.json") as KnownAnswer;
const direct = readJson("wildbloom-direct-v1.json") as Direct;

/** The entropy of the known-answer vector: its salt and nonce prefix, and the padding its independent verifier writes. */
function vectorEntropy(vector: KnownAnswer): EnvelopeEntropy {
  return {
    noncePrefix: () => Uint8Array.from(Buffer.from(vector.noncePrefixHex, "hex")),
    salt: () => Uint8Array.from(Buffer.from(vector.saltHex, "hex")),
    inputKey: () => { throw new Error("The vector supplies its key."); },
    padding(target, offset) {
      for (let index = 0; index < target.length; index += 1) target[index] = ((offset + index) * 73 + 41) & 0xff;
    },
  };
}

async function drain(encoder: EnvelopeEncoder): Promise<Uint8Array[]> {
  const records: Uint8Array[] = [];
  for (let record = await encoder.next(); record; record = await encoder.next()) records.push(record);
  return records;
}
const join = (parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const blobOf = (bytes: Uint8Array): Blob => new Blob([Uint8Array.from(bytes)]);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("the streaming FSWNENC2 encoder", () => {
  it("reproduces the per-file known-answer envelope byte for byte", async () => {
    const key = `wbk1_${Buffer.from(knownAnswer.testOnlyInputKeyHex, "hex").toString("base64url")}`;
    const source = new Blob([knownAnswer.source.utf8]);
    const encoder = await createEnvelopeEncoder(source, { name: knownAnswer.source.name, type: knownAnswer.source.type }, { key, entropy: vectorEntropy(knownAnswer) });
    expect(Buffer.from(encoder.header).toString("hex")).toBe(knownAnswer.headerHex);
    expect(encoder.envelopeBytes).toBe(knownAnswer.envelopeBytes);
    expect(encoder.recordCount).toBe(1);
    expect(encoder.inputKey).toBe(key);
    const envelope = join([encoder.header, ...(await drain(encoder))]);
    expect(envelope.length).toBe(knownAnswer.envelopeBytes);
    expect(sha256(envelope)).toBe(knownAnswer.envelopeSha256);
    expect(envelope.toString("base64")).toBe(knownAnswer.envelopeBase64);
    expect(Buffer.from(encoder.digest()).toString("hex")).toBe(knownAnswer.source.sha256);
    encoder.dispose();
  });

  it("measures every envelope in the protocol's length table from the manifest alone", () => {
    expect(direct.envelopes.length).toBeGreaterThanOrEqual(6);
    for (const entry of direct.envelopes) {
      expect(envelopeBytes(entry.name, entry.type, entry.size), entry.name).toBe(entry.envelopeBytes);
      expect(Math.ceil(entry.paddedBytes / 1_048_576)).toBe(entry.records);
    }
  });

  it("agrees with its own length for a source of several records and opens under the reader", async () => {
    const bytes = new Uint8Array(2 * 1_048_576 + 12_345).map((_, index) => (index * 31 + (index >> 8)) & 0xff);
    const file = new File([bytes], "three records.bin", { type: "application/octet-stream" });
    const key = newInputKey();
    const encoder = await createEnvelopeEncoder(file, { name: file.name, type: file.type }, { key });
    expect(encoder.recordCount).toBe(3);
    expect(encoder.envelopeBytes).toBe(envelopeBytes(file.name, file.type, file.size));
    const records = await drain(encoder);
    expect(records.map((record) => record.length)).toEqual([1_048_576 + 16, 1_048_576 + 16, 1_048_576 + 16]);
    expect(await drain(encoder)).toEqual([]);
    const envelope = join([encoder.header, ...records]);
    expect(envelope.length).toBe(encoder.envelopeBytes);
    expect(Buffer.from(encoder.digest()).toString("hex")).toBe(sha256(bytes));
    const opened = await decryptPrivacyEnvelope(blobOf(envelope), key);
    expect(opened.name).toBe("three records.bin");
    expect(Buffer.from(await opened.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  }, 30_000);

  it("seals a source that needs padding in a bucket of its own and fills only the padding", async () => {
    const calls: [number, number][] = [];
    const entropy: EnvelopeEntropy = {
      ...vectorEntropy(knownAnswer),
      padding(target, offset) {
        calls.push([offset, target.length]);
        target.fill(0xaa);
      },
    };
    const source = new Blob(["abc"]);
    const key = newInputKey();
    const encoder = await createEnvelopeEncoder(source, { name: "a.txt", type: "text/plain" }, { key, entropy });
    const envelope = join([encoder.header, ...(await drain(encoder))]);
    const prefixAndSource = 4 + new TextEncoder().encode('{"name":"a.txt","size":3,"type":"text/plain"}').length + 3;
    expect(calls).toEqual([[prefixAndSource, 65_536 - prefixAndSource]]);
    expect((await decryptPrivacyEnvelope(blobOf(envelope), key)).size).toBe(3);
  });

  it("makes an envelope for an empty source, which the protocol allows, though the page never sends one", async () => {
    const encoder = await createEnvelopeEncoder(new Blob([]), { name: "empty.txt", type: "text/plain" });
    expect(encoder.envelopeBytes).toBe(65_608);
    const envelope = join([encoder.header, ...(await drain(encoder))]);
    expect(envelope.length).toBe(65_608);
    expect(Buffer.from(encoder.digest()).toString("hex")).toBe(sha256(new Uint8Array(0)));
  });

  it("uses a supplied key, refuses a malformed one and makes a fresh canonical one otherwise", async () => {
    const key = newInputKey();
    expect(key).toMatch(/^wbk1_[A-Za-z0-9_-]{43}$/u);
    expect(newInputKey()).not.toBe(key);
    const bytes = parseInputKey(key);
    expect(bytes.length).toBe(32);
    const supplied = await createEnvelopeEncoder(new Blob(["x"]), { name: "x", type: "" }, { key });
    expect(supplied.inputKey).toBe(key);
    const made = await createEnvelopeEncoder(new Blob(["x"]), { name: "x", type: "" });
    expect(made.inputKey).toMatch(/^wbk1_/u);
    expect(made.inputKey).not.toBe(key);
    await expect(createEnvelopeEncoder(new Blob(["x"]), { name: "x", type: "" }, { key: "wbk1_short" })).rejects.toThrow();
    await expect(createEnvelopeEncoder(new Blob(["x"]), { name: "x", type: "" }, { key: key.replace("wbk1_", "wbk2_") })).rejects.toThrow();
    expect(() => parseInputKey(`${key.slice(0, -1)}B`)).toThrow();
  });

  it("gives each envelope its own salt and nonce prefix even under one key", async () => {
    const key = newInputKey();
    const first = await createEnvelopeEncoder(new Blob(["same"]), { name: "s", type: "" }, { key });
    const second = await createEnvelopeEncoder(new Blob(["same"]), { name: "s", type: "" }, { key });
    expect(Buffer.from(first.header.subarray(16)).equals(Buffer.from(second.header.subarray(16)))).toBe(false);
  });

  it("stops if the file shrinks while it is being read", async () => {
    const real = new Blob(["0123456789"]);
    const shrinking = {
      size: 10,
      slice: () => ({ arrayBuffer: async () => new TextEncoder().encode("0123").buffer }),
    } as unknown as Blob;
    expect(real.size).toBe(10);
    const encoder = await createEnvelopeEncoder(shrinking, { name: "a", type: "" });
    await expect(encoder.next()).rejects.toThrow(/changed/u);
  });

  it("stops when cancelled, refuses overlapping calls and withholds the digest until the end", async () => {
    const controller = new AbortController();
    const encoder = await createEnvelopeEncoder(new Blob(["abc"]), { name: "a", type: "" }, { signal: controller.signal });
    expect(() => encoder.digest()).toThrow();
    const first = encoder.next();
    await expect(encoder.next()).rejects.toThrow(/one record at a time/u);
    await first;
    expect(encoder.digest()).toHaveLength(32);
    const cancelled = new AbortController();
    const second = await createEnvelopeEncoder(new Blob(["abc"]), { name: "a", type: "" }, { signal: cancelled.signal });
    cancelled.abort();
    await expect(second.next()).rejects.toThrow(/cancelled/u);
    await expect(createEnvelopeEncoder(new Blob(["abc"]), { name: "a", type: "" }, { signal: cancelled.signal })).rejects.toThrow(/cancelled/u);
  });

  it("refuses a source over the 256 MiB cap before reading anything", async () => {
    const huge = { size: 256 * 1024 * 1024 + 1, slice: () => { throw new Error("read"); } } as unknown as Blob;
    await expect(createEnvelopeEncoder(huge, { name: "a", type: "" })).rejects.toThrow(/limited to 256 MiB/u);
    expect(() => envelopeBytes("a", "", -1)).toThrow();
  });

  it("still makes the whole-file envelope the rest of the page uses", async () => {
    const protectedFile = await encryptPrivacyEnvelope(new File(["hello"], "hello.txt", { type: "Text/Plain" }));
    expect(protectedFile.sourceType).toBe("text/plain");
    expect(protectedFile.file.size).toBe(envelopeBytes("hello.txt", "text/plain", 5));
    await expect(encryptPrivacyEnvelope(new File([], "empty.txt"))).rejects.toThrow(/non-empty/u);
  });
});
