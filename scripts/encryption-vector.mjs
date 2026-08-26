import { strict as assert } from "node:assert";
import { createCipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHUNK_BYTES = 1024 * 1024;
const primaryVectorFile = "test-vectors/encryption-v1.json";
const multiRecordVectorFile = "test-vectors/encryption-v1-two-records.json";
const primaryVector = JSON.parse(readFileSync(
  fileURLToPath(new URL(`../${primaryVectorFile}`, import.meta.url)),
  "utf8",
));
const multiRecordVector = JSON.parse(readFileSync(
  fileURLToPath(new URL(`../${multiRecordVectorFile}`, import.meta.url)),
  "utf8",
));
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
  const header = Buffer.alloc(24);
  header.write("WBLMENC1", 0, "ascii");
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
  const primaryFixture = generateKnownAnswerEnvelope();
  const multiRecordFixture = generateMultiRecordKnownAnswerEnvelope();
  process.stdout.write(
    `Encryption vectors passed: one record ${primaryFixture.envelope.length} bytes, SHA-256 ${primaryFixture.envelopeSha256}; `
    + `two records ${multiRecordFixture.envelope.length} bytes, SHA-256 ${multiRecordFixture.envelopeSha256}.\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) run();
