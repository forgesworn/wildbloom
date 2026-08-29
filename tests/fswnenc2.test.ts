import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The reference encoder/decoder for the shared FSWNENC2 contract.
import { deriveEnvelopeKey, open, seal } from "../scripts/fswnenc2-vector.mjs";

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

const perFile = load("fswnenc2-per-file.json");
const vault = load("fswnenc2-vault.json");

function reseal(vector: Fswnenc2Vector) {
  return seal({
    inputKey: Buffer.from(vector.testOnlyInputKeyHex, "hex"),
    salt: Buffer.from(vector.saltHex, "hex"),
    noncePrefix: Buffer.from(vector.noncePrefixHex, "hex"),
    source: Buffer.from(vector.source.utf8, "utf8"),
    name: vector.source.name,
    type: vector.source.type,
  });
}

describe("FSWNENC2 known-answer vectors", () => {
  it.each([perFile, vault])("reproduces the $mode vector byte-for-byte", (vector) => {
    const sealed = reseal(vector);
    expect(sealed.header.toString("hex")).toBe(vector.headerHex);
    expect(sealed.header.length).toBe(56);
    expect(sealed.records[0].authenticationTagHex).toBe(vector.records[0].authenticationTagHex);
    expect(sealed.envelope.length).toBe(vector.envelopeBytes);
    expect(sealed.envelopeSha256).toBe(vector.envelopeSha256);
  });

  it.each([perFile, vault])("round-trips the $mode vector under its input key", (vector) => {
    const envelope = Buffer.from(vector.envelopeBase64, "base64");
    const recovered = open(envelope, Buffer.from(vector.testOnlyInputKeyHex, "hex"));
    expect(recovered.metadata.size).toBe(vector.source.bytes);
    expect(Buffer.from(recovered.source).toString("utf8")).toBe(vector.source.utf8);
  });

  it("derives a distinct key per mode from the same salt and nonce prefix", () => {
    const salt = Buffer.from(perFile.saltHex, "hex");
    expect(perFile.saltHex).toBe(vault.saltHex);
    expect(perFile.noncePrefixHex).toBe(vault.noncePrefixHex);
    const perFileKey = deriveEnvelopeKey(Buffer.from(perFile.testOnlyInputKeyHex, "hex"), salt).toString("hex");
    const vaultKey = deriveEnvelopeKey(Buffer.from(vault.testOnlyInputKeyHex, "hex"), salt).toString("hex");
    expect(perFileKey).toBe(perFile.testOnlyDerivedKeyHex);
    expect(vaultKey).toBe(vault.testOnlyDerivedKeyHex);
    expect(perFileKey).not.toBe(vaultKey);
  });

  it("rejects a flipped authentication tag", () => {
    const envelope = Buffer.from(perFile.envelopeBase64, "base64");
    envelope[envelope.length - 1] ^= 0x01;
    expect(() => open(envelope, Buffer.from(perFile.testOnlyInputKeyHex, "hex"))).toThrow();
  });
});
