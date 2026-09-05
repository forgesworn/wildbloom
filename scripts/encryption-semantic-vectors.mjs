// Public, deterministic test material. These envelopes have valid GCM tags:
// rejection must reach the authenticated metadata/padding checks, rather than
// succeeding merely because an arbitrary ciphertext mutation breaks AEAD.
import { createCipheriv, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const inputKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const source = Buffer.from("Authenticated semantic vector\n");
const metadata = { name: "semantic.txt", size: source.length, type: "text/plain" };
const cases = [];

for (const magic of ["WBLMENC1", "FSWNENC1", "FSWNENC2"]) {
  for (const category of ["none", "metadata", "padding"]) {
    const v2 = magic === "FSWNENC2";
    const header = Buffer.alloc(v2 ? 56 : 24);
    header.write(magic, 0, "ascii");
    header.writeUInt32BE(1048576, 8);
    header.writeUInt32BE(1, 12);
    // Distinct test nonces for every construction, including legacy variants.
    header.fill(0xa0 + cases.length, 16, 24);
    if (v2) header.fill(0xe0 + cases.length, 24, 56);
    const key = v2 ? Buffer.from(hkdfSync(
      "sha256", inputKey, header.subarray(24),
      Buffer.from("forgesworn-aes-256-gcm-chunked/v2"), 32,
    )) : inputKey;
    const json = Buffer.from(category === "metadata"
      ? JSON.stringify({ size: metadata.size, name: metadata.name, type: metadata.type })
      : JSON.stringify(metadata));
    // The wrong bucket is still a well-framed, fully authenticated record.
    const plaintext = Buffer.alloc(category === "padding" ? 131072 : 65536, 0x42);
    plaintext.writeUInt32BE(json.length);
    json.copy(plaintext, 4);
    source.copy(plaintext, 4 + json.length);
    const nonce = Buffer.concat([header.subarray(16, 24), Buffer.alloc(4)]);
    const aad = Buffer.concat([header, Buffer.alloc(4)]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const envelope = Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    cases.push({
      id: `${magic.toLowerCase()}-${category}`,
      magic,
      category,
      recoveryKey: `wbk1_${inputKey.toString("base64url")}`,
      envelopeBase64: envelope.toString("base64"),
    });
  }
}

const suite = {
  format: "forgesworn-encryption-semantic-v1",
  note: "Public test-only keys and bytes. Every record authenticates. Metadata cases reject non-canonical key order; padding cases reject an oversized padding bucket. Controls recover the exact source.",
  source: source.toString("utf8"),
  cases,
};
const target = fileURLToPath(new URL("../test-vectors/encryption-semantic.json", import.meta.url));
const serialised = `${JSON.stringify(suite, null, 2)}\n`;
if (process.argv.includes("--write")) {
  writeFileSync(target, serialised);
} else if (readFileSync(target, "utf8") !== serialised) {
  throw new Error("Committed semantic vectors differ from the independent generator.");
}
process.stdout.write(`Verified ${cases.length} authenticated semantic vectors across all three envelope versions.\n`);
