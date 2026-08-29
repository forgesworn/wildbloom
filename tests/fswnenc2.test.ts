import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// An independent verifier of the FSWNENC2 known-answer vectors. It reimplements
// the construction from docs/FSWNENC2.md with Node's crypto so the committed
// vectors are checked against a second implementation, not against the
// generator that produced them.

const HKDF_INFO = "forgesworn-aes-256-gcm-chunked/v2";
const HEADER_BYTES = 56;
const TAG_BYTES = 16;

interface Fswnenc2Vector {
  mode: string;
  testOnlyInputKeyHex: string;
  testOnlyDerivedKeyHex: string;
  saltHex: string;
  noncePrefixHex: string;
  headerHex: string;
  source: { utf8: string; name: string; type: string; bytes: number };
  records: { authenticationTagHex: string }[];
  envelopeBytes: number;
  envelopeSha256: string;
  envelopeBase64: string;
}

function load(name: string): Fswnenc2Vector {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../test-vectors/${name}`, import.meta.url)), "utf8"),
  ) as Fswnenc2Vector;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function derive(inputKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", inputKey, salt, Buffer.from(HKDF_INFO, "utf8"), 32));
}

function paddedLength(length: number): number {
  if (length <= 64 * 1024) return 64 * 1024;
  if (length <= 1024 * 1024) return 2 ** Math.ceil(Math.log2(length));
  return Math.ceil(length / (1024 * 1024)) * 1024 * 1024;
}

interface Sealed {
  header: Buffer;
  firstTagHex: string;
  envelope: Buffer;
}

function seal(vector: Fswnenc2Vector): Sealed {
  const inputKey = Buffer.from(vector.testOnlyInputKeyHex, "hex");
  const salt = Buffer.from(vector.saltHex, "hex");
  const noncePrefix = Buffer.from(vector.noncePrefixHex, "hex");
  const source = Buffer.from(vector.source.utf8, "utf8");
  const key = derive(inputKey, salt);

  const metadata = Buffer.from(
    JSON.stringify({ name: vector.source.name, size: source.length, type: vector.source.type }),
    "utf8",
  );
  const plaintext = Buffer.alloc(paddedLength(4 + metadata.length + source.length));
  for (let i = 0; i < plaintext.length; i += 1) plaintext[i] = (i * 73 + 41) & 0xff;
  plaintext.writeUInt32BE(metadata.length, 0);
  metadata.copy(plaintext, 4);
  source.copy(plaintext, 4 + metadata.length);

  const chunk = 1024 * 1024;
  const recordCount = Math.ceil(plaintext.length / chunk);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("FSWNENC2", 0, "latin1");
  header.writeUInt32BE(chunk, 8);
  header.writeUInt32BE(recordCount, 12);
  noncePrefix.copy(header, 16);
  salt.copy(header, 24);

  const parts: Buffer[] = [header];
  const tags: string[] = [];
  let offset = 0;
  for (let counter = 0; counter < recordCount; counter += 1) {
    const body = plaintext.subarray(offset, Math.min(offset + chunk, plaintext.length));
    offset += body.length;
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce);
    nonce.writeUInt32BE(counter, 8);
    const aad = Buffer.alloc(HEADER_BYTES + 4);
    header.copy(aad, 0);
    aad.writeUInt32BE(counter, HEADER_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad, { plaintextLength: body.length });
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    parts.push(ciphertext, cipher.getAuthTag());
    tags.push(cipher.getAuthTag().toString("hex"));
  }
  const firstTagHex = tags[0] ?? "";
  return { header, firstTagHex, envelope: Buffer.concat(parts) };
}

function openEnvelope(envelope: Buffer, inputKey: Buffer): { size: number; source: Buffer } {
  const salt = envelope.subarray(24, 56);
  const key = derive(inputKey, salt);
  const chunk = envelope.readUInt32BE(8);
  const recordCount = envelope.readUInt32BE(12);
  const noncePrefix = envelope.subarray(16, 24);
  const header = envelope.subarray(0, HEADER_BYTES);
  const parts: Buffer[] = [];
  let offset = HEADER_BYTES;
  for (let counter = 0; counter < recordCount; counter += 1) {
    const isLast = counter === recordCount - 1;
    const bodyLength = isLast ? envelope.length - offset - TAG_BYTES : chunk;
    const ciphertext = envelope.subarray(offset, offset + bodyLength);
    const tag = envelope.subarray(offset + bodyLength, offset + bodyLength + TAG_BYTES);
    offset += bodyLength + TAG_BYTES;
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce);
    nonce.writeUInt32BE(counter, 8);
    const aad = Buffer.alloc(HEADER_BYTES + 4);
    header.copy(aad, 0);
    aad.writeUInt32BE(counter, HEADER_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    parts.push(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }
  const plaintext = Buffer.concat(parts);
  const metadataLength = plaintext.readUInt32BE(0);
  const metadata = JSON.parse(plaintext.subarray(4, 4 + metadataLength).toString("utf8")) as { size: number };
  const source = Buffer.from(plaintext.subarray(4 + metadataLength, 4 + metadataLength + metadata.size));
  return { size: metadata.size, source };
}

const perFile = load("fswnenc2-per-file.json");
const vault = load("fswnenc2-vault.json");

describe("FSWNENC2 known-answer vectors", () => {
  it.each([perFile, vault])("reproduces the $mode vector byte-for-byte", (vector) => {
    const sealed = seal(vector);
    expect(sealed.header.length).toBe(56);
    expect(sealed.header.toString("hex")).toBe(vector.headerHex);
    const expectedTag = vector.records[0]?.authenticationTagHex ?? "";
    expect(sealed.firstTagHex).toBe(expectedTag);
    expect(sealed.envelope.length).toBe(vector.envelopeBytes);
    expect(sha256Hex(sealed.envelope)).toBe(vector.envelopeSha256);
  });

  it.each([perFile, vault])("round-trips the $mode vector under its input key", (vector) => {
    const envelope = Buffer.from(vector.envelopeBase64, "base64");
    const recovered = openEnvelope(envelope, Buffer.from(vector.testOnlyInputKeyHex, "hex"));
    expect(recovered.size).toBe(vector.source.bytes);
    expect(recovered.source.toString("utf8")).toBe(vector.source.utf8);
  });

  it("derives a distinct key per mode from the same salt and nonce prefix", () => {
    expect(perFile.saltHex).toBe(vault.saltHex);
    expect(perFile.noncePrefixHex).toBe(vault.noncePrefixHex);
    const salt = Buffer.from(perFile.saltHex, "hex");
    const perFileKey = derive(Buffer.from(perFile.testOnlyInputKeyHex, "hex"), salt).toString("hex");
    const vaultKey = derive(Buffer.from(vault.testOnlyInputKeyHex, "hex"), salt).toString("hex");
    expect(perFileKey).toBe(perFile.testOnlyDerivedKeyHex);
    expect(vaultKey).toBe(vault.testOnlyDerivedKeyHex);
    expect(perFileKey).not.toBe(vaultKey);
  });

  it("rejects a flipped authentication tag", () => {
    const envelope = Buffer.from(perFile.envelopeBase64, "base64");
    const last = envelope.length - 1;
    envelope[last] = (envelope[last] ?? 0) ^ 0x01;
    expect(() => openEnvelope(envelope, Buffer.from(perFile.testOnlyInputKeyHex, "hex"))).toThrow();
  });
});
