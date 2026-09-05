// Reference generator and known-answer vectors for FSWNENC2, the coordinated
// successor to FSWNENC1. FSWNENC2 closes the shared-key (vault) nonce-reuse
// exposure by carrying a 32-byte salt in the clear header and deriving the AES
// key per envelope with HKDF-SHA256. The header layout and derivation are
// identical for per-file and vault sealing; only the input key material
// differs, and that difference is invisible in the envelope.
//
// This is the shared contract between the Wildbloom and Stash implementations.
// Both sides now write FSWNENC2 and retain their historical readers. These
// deterministic test keys, salts and padding are never production inputs.
//
// Run `node scripts/fswnenc2-vector.mjs` to regenerate the vectors under
// test-vectors/. The suite (tests/fswnenc2.test.ts) checks they are
// self-consistent and round-trip.

import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const MAGIC = Buffer.from("FSWNENC2", "latin1");
const CHUNK_BYTES = 1024 * 1024;
const HKDF_INFO = Buffer.from("forgesworn-aes-256-gcm-chunked/v2", "utf8");
const SCHEME = "forgesworn-aes-256-gcm-chunked-v2";
const SALT_BYTES = 32;
const HEADER_BYTES = 56; // magic 8 | chunk 4 | count 4 | nonce prefix 8 | salt 32
const TAG_BYTES = 16;

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The padding bucket is identical to FSWNENC1: a function of the logical length.
function paddedPlaintextLength(length) {
  if (length <= 64 * 1024) return 64 * 1024;
  if (length <= CHUNK_BYTES) return 2 ** Math.ceil(Math.log2(length));
  return Math.ceil(length / CHUNK_BYTES) * CHUNK_BYTES;
}

// envelope_key = HKDF-SHA256(ikm = input key, salt = header salt, info = label).
function deriveEnvelopeKey(inputKey, salt) {
  return Buffer.from(hkdfSync("sha256", inputKey, salt, HKDF_INFO, 32));
}

function buildHeader(recordCount, noncePrefix, salt) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(CHUNK_BYTES, 8);
  header.writeUInt32BE(recordCount, 12);
  noncePrefix.copy(header, 16);
  salt.copy(header, 24);
  return header;
}

function seal({ inputKey, salt, noncePrefix, source, name, type }) {
  const envelopeKey = deriveEnvelopeKey(inputKey, salt);

  const metadata = Buffer.from(JSON.stringify({ name, size: source.length, type }), "utf8");
  const logicalLength = 4 + metadata.length + source.length;
  const plaintext = Buffer.alloc(paddedPlaintextLength(logicalLength));
  // Deterministic padding fill so the vector is reproducible, then overwrite
  // the head with the real metadata and source. Production uses random padding.
  for (let index = 0; index < plaintext.length; index += 1) plaintext[index] = (index * 73 + 41) & 0xff;
  plaintext.writeUInt32BE(metadata.length, 0);
  metadata.copy(plaintext, 4);
  source.copy(plaintext, 4 + metadata.length);

  const recordCount = Math.ceil(plaintext.length / CHUNK_BYTES);
  const header = buildHeader(recordCount, noncePrefix, salt);

  const parts = [header];
  const records = [];
  let offset = 0;
  for (let counter = 0; counter < recordCount; counter += 1) {
    const body = plaintext.subarray(offset, Math.min(offset + CHUNK_BYTES, plaintext.length));
    offset += body.length;
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce);
    nonce.writeUInt32BE(counter, 8);
    const aad = Buffer.alloc(HEADER_BYTES + 4);
    header.copy(aad, 0);
    aad.writeUInt32BE(counter, HEADER_BYTES);
    const cipher = createCipheriv("aes-256-gcm", envelopeKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad, { plaintextLength: body.length });
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    const tag = cipher.getAuthTag();
    parts.push(ciphertext, tag);
    records.push({
      counter,
      nonceHex: nonce.toString("hex"),
      aadHex: aad.toString("hex"),
      authenticationTagHex: tag.toString("hex"),
    });
  }

  const envelope = Buffer.concat(parts);
  return {
    envelopeKey,
    metadata,
    plaintext,
    header,
    records,
    envelope,
    envelopeSha256: sha256Hex(envelope),
  };
}

// Independent inverse, so the vector proves it round-trips.
function open(envelope, inputKey) {
  const salt = envelope.subarray(24, 56);
  const envelopeKey = deriveEnvelopeKey(inputKey, salt);
  const chunkSize = envelope.readUInt32BE(8);
  const recordCount = envelope.readUInt32BE(12);
  const noncePrefix = envelope.subarray(16, 24);
  const header = envelope.subarray(0, HEADER_BYTES);
  const parts = [];
  let offset = HEADER_BYTES;
  for (let counter = 0; counter < recordCount; counter += 1) {
    const isLast = counter === recordCount - 1;
    const bodyLength = isLast ? envelope.length - offset - TAG_BYTES : chunkSize;
    const ciphertext = envelope.subarray(offset, offset + bodyLength);
    const tag = envelope.subarray(offset + bodyLength, offset + bodyLength + TAG_BYTES);
    offset += bodyLength + TAG_BYTES;
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce);
    nonce.writeUInt32BE(counter, 8);
    const aad = Buffer.alloc(HEADER_BYTES + 4);
    header.copy(aad, 0);
    aad.writeUInt32BE(counter, HEADER_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", envelopeKey, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    parts.push(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }
  const plaintext = Buffer.concat(parts);
  const metadataLength = plaintext.readUInt32BE(0);
  const metadata = JSON.parse(plaintext.subarray(4, 4 + metadataLength).toString("utf8"));
  const source = Buffer.from(plaintext.subarray(4 + metadataLength, 4 + metadataLength + metadata.size));
  return { metadata, source };
}

// Deterministic, distinct test constants. Public test material only.
const NONCE_PREFIX = Buffer.from("d0d1d2d3d4d5d6d7", "hex");
const SALT = Buffer.from(Array.from({ length: SALT_BYTES }, (_, i) => 0xe0 + i)); // e0..ff
const PER_FILE_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)); // 00..1f
const VAULT_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x40 + i)); // 40..5f
const SOURCE = Buffer.from("ForgeSworn envelope v2 known-answer vector\n", "utf8");

function vector(mode, inputKey) {
  const sealed = seal({
    inputKey,
    salt: SALT,
    noncePrefix: NONCE_PREFIX,
    source: SOURCE,
    name: "known-answer.txt",
    type: "text/plain",
  });
  // Prove it round-trips under the same input key.
  const recovered = open(sealed.envelope, inputKey);
  if (recovered.metadata.size !== SOURCE.length || sha256Hex(recovered.source) !== sha256Hex(SOURCE)) {
    throw new Error(`FSWNENC2 ${mode} vector failed to round-trip`);
  }
  return {
    format: "forgesworn-encryption-known-answer-v2",
    scheme: SCHEME,
    magic: "FSWNENC2",
    mode,
    hkdfInfo: HKDF_INFO.toString("utf8"),
    testOnlyInputKeyHex: inputKey.toString("hex"),
    testOnlyDerivedKeyHex: sealed.envelopeKey.toString("hex"),
    saltHex: SALT.toString("hex"),
    noncePrefixHex: NONCE_PREFIX.toString("hex"),
    headerHex: sealed.header.toString("hex"),
    source: { utf8: SOURCE.toString("utf8"), name: "known-answer.txt", type: "text/plain", bytes: SOURCE.length, sha256: sha256Hex(SOURCE) },
    metadata: { canonicalUtf8: sealed.metadata.toString("utf8"), bytes: sealed.metadata.length },
    records: sealed.records,
    envelopeBytes: sealed.envelope.length,
    envelopeSha256: sealed.envelopeSha256,
    envelopeBase64: sealed.envelope.toString("base64"),
  };
}

function run() {
  const perFile = vector("per-file", PER_FILE_KEY);
  const vault = vector("vault", VAULT_KEY);
  const dir = fileURLToPath(new URL("../test-vectors/", import.meta.url));
  writeFileSync(`${dir}fswnenc2-per-file.json`, `${JSON.stringify(perFile, null, 2)}\n`);
  writeFileSync(`${dir}fswnenc2-vault.json`, `${JSON.stringify(vault, null, 2)}\n`);
  process.stdout.write(
    `FSWNENC2 vectors written. per-file envelope SHA-256 ${perFile.envelopeSha256}; `
    + `vault envelope SHA-256 ${vault.envelopeSha256}. `
    + `Same salt and nonce prefix, distinct derived keys: `
    + `${perFile.testOnlyDerivedKeyHex.slice(0, 8)}… vs ${vault.testOnlyDerivedKeyHex.slice(0, 8)}….\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) run();

export { seal, open, deriveEnvelopeKey, vector };
