import { strict as assert } from "node:assert";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHUNK_BYTES = 1024 * 1024;
// New frames carry the product-neutral magic; legacy frames carry WBLMENC1.
// The generator reads whichever magic a vector's header declares.
const ENVELOPE_MAGIC = "FSWNENC1";
const ENVELOPE_MAGIC_LEGACY = "WBLMENC1";
const primaryVectorFile = "test-vectors/encryption-v1.json";
const multiRecordVectorFile = "test-vectors/encryption-v1-two-records.json";
const v2VectorFile = "test-vectors/encryption-v2.json";
const v2MultiRecordVectorFile = "test-vectors/encryption-v2-two-records.json";
function loadVector(file) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8"));
}
const primaryVector = loadVector(primaryVectorFile);
const multiRecordVector = loadVector(multiRecordVectorFile);
const v2Vector = loadVector(v2VectorFile);
const v2MultiRecordVector = loadVector(v2MultiRecordVectorFile);
const EXPECTED_FORMAT = "wildbloom-encryption-known-answer-v1";
const EXPECTED_SCHEME = "wildbloom-aes-256-gcm-chunked-v1";
const EXPECTED_PADDING_FORMULA = "byte[i] = (i * 73 + 41) mod 256 before metadata and source overwrite";
const EXPECTED_SOURCE_FORMULA = "byte[i] = (i * 29 + 7) mod 256";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function equal(actual, expected, label, vectorFile) {
  assert.equal(actual, expected, `${label} does not match ${vectorFile}`);
}

function paddedPlaintextLength(length) {
  if (length <= 64 * 1024) return 64 * 1024;
  if (length <= CHUNK_BYTES) return 2 ** Math.ceil(Math.log2(length));
  return Math.ceil(length / CHUNK_BYTES) * CHUNK_BYTES;
}

function generateSource(vector, vectorFile) {
  if (typeof vector.source.utf8 === "string") return Buffer.from(vector.source.utf8, "utf8");
  equal(vector.source.formula, EXPECTED_SOURCE_FORMULA, "Source formula", vectorFile);
  const source = Buffer.alloc(vector.source.bytes);
  for (let index = 0; index < source.length; index += 1) source[index] = (index * 29 + 7) & 0xff;
  return source;
}

function generateVector(vector, vectorFile) {
  equal(vector.format, EXPECTED_FORMAT, "Vector format", vectorFile);
  equal(vector.scheme, EXPECTED_SCHEME, "Encryption scheme", vectorFile);
  equal(vector.padding.formula, EXPECTED_PADDING_FORMULA, "Padding formula", vectorFile);

  const source = generateSource(vector, vectorFile);
  equal(source.length, vector.source.bytes, "Source length", vectorFile);
  equal(sha256(source), vector.source.sha256, "Source SHA-256", vectorFile);

  const metadata = Buffer.from(JSON.stringify({
    name: vector.source.name,
    size: source.length,
    type: vector.source.type,
  }), "utf8");
  equal(metadata.toString("utf8"), vector.metadata.canonicalUtf8, "Canonical metadata", vectorFile);
  equal(metadata.length, vector.metadata.bytes, "Metadata length", vectorFile);

  const plaintext = Buffer.alloc(vector.padding.plaintextBytes);
  for (let index = 0; index < plaintext.length; index += 1) plaintext[index] = (index * 73 + 41) & 0xff;
  equal(
    plaintext.length,
    paddedPlaintextLength(4 + metadata.length + source.length),
    "Padding bucket",
    vectorFile,
  );
  plaintext.writeUInt32BE(metadata.length, 0);
  metadata.copy(plaintext, 4);
  source.copy(plaintext, 4 + metadata.length);
  equal(sha256(plaintext), vector.plaintextSha256, "Plaintext SHA-256", vectorFile);

  const rawKey = Buffer.from(vector.testOnlyKey.rawHex, "hex");
  equal(rawKey.length, 32, "Test key length", vectorFile);
  equal(`wbk1_${rawKey.toString("base64url")}`, vector.testOnlyKey.recoveryKey, "Recovery key", vectorFile);
  const noncePrefix = Buffer.from(vector.noncePrefixHex, "hex");
  equal(noncePrefix.length, 8, "Nonce prefix length", vectorFile);

  const recordCount = Math.ceil(plaintext.length / CHUNK_BYTES);
  const magic = Buffer.from(vector.headerHex.slice(0, 16), "hex");
  const magicText = magic.toString("latin1");
  if (magicText !== ENVELOPE_MAGIC && magicText !== ENVELOPE_MAGIC_LEGACY) {
    throw new Error(`${vectorFile} declares an unrecognised envelope magic ${JSON.stringify(magicText)}`);
  }
  const header = Buffer.alloc(24);
  magic.copy(header, 0);
  header.writeUInt32BE(CHUNK_BYTES, 8);
  header.writeUInt32BE(recordCount, 12);
  noncePrefix.copy(header, 16);
  equal(header.toString("hex"), vector.headerHex, "Header", vectorFile);
  if (Array.isArray(vector.records)) equal(vector.records.length, recordCount, "Record count", vectorFile);
  else equal(recordCount, 1, "Record count", vectorFile);

  try {
    const envelopeParts = [header];
    for (let counter = 0; counter < recordCount; counter += 1) {
      const expectedRecord = Array.isArray(vector.records)
        ? vector.records[counter]
        : {
            counter: 0,
            additionalAuthenticatedDataHex: vector.additionalAuthenticatedDataHex,
            ciphertextSha256: vector.ciphertextSha256,
            authenticationTagHex: vector.authenticationTagHex,
          };
      equal(expectedRecord.counter, counter, `Record ${counter} counter`, vectorFile);
      const nonce = Buffer.alloc(12);
      noncePrefix.copy(nonce);
      nonce.writeUInt32BE(counter, 8);
      if (expectedRecord.nonceHex !== undefined) {
        equal(nonce.toString("hex"), expectedRecord.nonceHex, `Record ${counter} nonce`, vectorFile);
      }
      const additionalData = Buffer.alloc(28);
      header.copy(additionalData);
      additionalData.writeUInt32BE(counter, 24);
      equal(
        additionalData.toString("hex"),
        expectedRecord.additionalAuthenticatedDataHex,
        `Record ${counter} additional authenticated data`,
        vectorFile,
      );
      const plaintextChunk = plaintext.subarray(counter * CHUNK_BYTES, (counter + 1) * CHUNK_BYTES);
      if (expectedRecord.plaintextSha256 !== undefined) {
        equal(
          sha256(plaintextChunk),
          expectedRecord.plaintextSha256,
          `Record ${counter} plaintext SHA-256`,
          vectorFile,
        );
      }
      const cipher = createCipheriv("aes-256-gcm", rawKey, nonce, { authTagLength: 16 });
      cipher.setAAD(additionalData, { plaintextLength: plaintextChunk.length });
      const ciphertext = Buffer.concat([cipher.update(plaintextChunk), cipher.final()]);
      const authenticationTag = cipher.getAuthTag();
      equal(
        sha256(ciphertext),
        expectedRecord.ciphertextSha256,
        `Record ${counter} ciphertext SHA-256`,
        vectorFile,
      );
      equal(
        authenticationTag.toString("hex"),
        expectedRecord.authenticationTagHex,
        `Record ${counter} authentication tag`,
        vectorFile,
      );
      envelopeParts.push(ciphertext, authenticationTag);
    }
    const envelope = Buffer.concat(envelopeParts);
    equal(envelope.length, vector.envelopeBytes, "Envelope length", vectorFile);
    equal(sha256(envelope), vector.envelopeSha256, "Envelope SHA-256", vectorFile);
    return {
      envelope,
      envelopeSha256: vector.envelopeSha256,
      recoveryKey: vector.testOnlyKey.recoveryKey,
      source,
      sourceName: vector.source.name,
      sourceSha256: vector.source.sha256,
      sourceType: vector.source.type,
    };
  } finally {
    plaintext.fill(0);
    rawKey.fill(0);
  }
}

export function generateKnownAnswerEnvelope() {
  return generateVector(primaryVector, primaryVectorFile);
}

export function generateMultiRecordKnownAnswerEnvelope() {
  return generateVector(multiRecordVector, multiRecordVectorFile);
}

export function generateV2KnownAnswerEnvelope() {
  return generateVector(v2Vector, v2VectorFile);
}

export function generateV2MultiRecordKnownAnswerEnvelope() {
  return generateVector(v2MultiRecordVector, v2MultiRecordVectorFile);
}

// Independent decrypt path. It reads the magic, chunk size, record count and
// nonce prefix straight from the envelope header, then authenticates every
// record with AAD built from those actual header bytes. A legacy WBLMENC1
// envelope and a new FSWNENC1 envelope are therefore each read under their own
// magic, which is the backward-compatibility claim this proves.
function decryptEnvelope(envelope, rawKey) {
  const magicText = envelope.subarray(0, 8).toString("latin1");
  if (magicText !== ENVELOPE_MAGIC && magicText !== ENVELOPE_MAGIC_LEGACY) {
    throw new Error(`Envelope magic ${JSON.stringify(magicText)} is not readable.`);
  }
  const chunkSize = envelope.readUInt32BE(8);
  const recordCount = envelope.readUInt32BE(12);
  const noncePrefix = envelope.subarray(16, 24);
  const header = envelope.subarray(0, 24);
  const plaintextParts = [];
  let offset = 24;
  for (let counter = 0; counter < recordCount; counter += 1) {
    const isLast = counter === recordCount - 1;
    const bodyLength = isLast ? envelope.length - offset - 16 : chunkSize;
    const ciphertext = envelope.subarray(offset, offset + bodyLength);
    const authenticationTag = envelope.subarray(offset + bodyLength, offset + bodyLength + 16);
    offset += bodyLength + 16;
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce);
    nonce.writeUInt32BE(counter, 8);
    const additionalData = Buffer.alloc(28);
    header.copy(additionalData);
    additionalData.writeUInt32BE(counter, 24);
    const decipher = createDecipheriv("aes-256-gcm", rawKey, nonce, { authTagLength: 16 });
    decipher.setAAD(additionalData, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(authenticationTag);
    plaintextParts.push(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }
  const plaintext = Buffer.concat(plaintextParts);
  const metadataLength = plaintext.readUInt32BE(0);
  const metadata = JSON.parse(plaintext.subarray(4, 4 + metadataLength).toString("utf8"));
  const source = Buffer.from(plaintext.subarray(4 + metadataLength, 4 + metadataLength + metadata.size));
  return { metadata, source };
}

function roundTripDecrypt(fixture, vector, vectorFile) {
  const rawKey = Buffer.from(vector.testOnlyKey.rawHex, "hex");
  try {
    const recovered = decryptEnvelope(fixture.envelope, rawKey);
    equal(recovered.metadata.name, vector.source.name, "Round-trip name", vectorFile);
    equal(recovered.metadata.type, vector.source.type, "Round-trip type", vectorFile);
    equal(recovered.metadata.size, vector.source.bytes, "Round-trip size", vectorFile);
    equal(sha256(recovered.source), vector.source.sha256, "Round-trip source SHA-256", vectorFile);
    return recovered;
  } finally {
    rawKey.fill(0);
  }
}

function emittedFixture(fixture) {
  return {
    envelopeBase64: fixture.envelope.toString("base64"),
    envelopeBytes: fixture.envelope.length,
    envelopeSha256: fixture.envelopeSha256,
    recoveryKey: fixture.recoveryKey,
    sourceBase64: fixture.source.toString("base64"),
    sourceName: fixture.sourceName,
    sourceSha256: fixture.sourceSha256,
    sourceType: fixture.sourceType,
  };
}

function run() {
  if (process.argv.length > 3) throw new Error("Encryption-vector accepts at most one option.");
  if (process.argv[2] === "--emit") {
    process.stdout.write(`${JSON.stringify(emittedFixture(generateKnownAnswerEnvelope()))}\n`);
    return;
  }
  if (process.argv[2] === "--emit-multirecord") {
    process.stdout.write(`${JSON.stringify(emittedFixture(generateMultiRecordKnownAnswerEnvelope()))}\n`);
    return;
  }
  if (process.argv[2] !== undefined) throw new Error(`Unknown encryption-vector option: ${process.argv[2]}`);
  // FSWNENC1 (magic the code emits) is the primary known-answer pair. The
  // legacy WBLMENC1 pair is validated too so the read-only compatibility path
  // stays pinned. Both build under the magic their own vector declares.
  const primaryFixture = generateV2KnownAnswerEnvelope();
  const multiRecordFixture = generateV2MultiRecordKnownAnswerEnvelope();
  const legacyFixture = generateKnownAnswerEnvelope();
  const legacyMultiRecordFixture = generateMultiRecordKnownAnswerEnvelope();
  process.stdout.write(
    `Encryption vectors passed (FSWNENC1): one record ${primaryFixture.envelope.length} bytes, SHA-256 ${primaryFixture.envelopeSha256}; `
    + `two records ${multiRecordFixture.envelope.length} bytes, SHA-256 ${multiRecordFixture.envelopeSha256}. `
    + `Legacy WBLMENC1 also passed: one record SHA-256 ${legacyFixture.envelopeSha256}, two records SHA-256 ${legacyMultiRecordFixture.envelopeSha256}.\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) run();
