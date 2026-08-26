import { strict as assert } from "node:assert";
import { createCipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const vectorPath = fileURLToPath(new URL("../test-vectors/encryption-v1.json", import.meta.url));
const vector = JSON.parse(readFileSync(vectorPath, "utf8"));
const EXPECTED_FORMAT = "wildbloom-encryption-known-answer-v1";
const EXPECTED_SCHEME = "wildbloom-aes-256-gcm-chunked-v1";
const EXPECTED_PADDING_FORMULA = "byte[i] = (i * 73 + 41) mod 256 before metadata and source overwrite";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function equal(actual, expected, label) {
  assert.equal(actual, expected, `${label} does not match test-vectors/encryption-v1.json`);
}

export function generateKnownAnswerEnvelope() {
  equal(vector.format, EXPECTED_FORMAT, "Vector format");
  equal(vector.scheme, EXPECTED_SCHEME, "Encryption scheme");
  equal(vector.padding.formula, EXPECTED_PADDING_FORMULA, "Padding formula");

  const source = Buffer.from(vector.source.utf8, "utf8");
  equal(source.length, vector.source.bytes, "Source length");
  equal(sha256(source), vector.source.sha256, "Source SHA-256");

  const metadata = Buffer.from(JSON.stringify({
    name: vector.source.name,
    size: source.length,
    type: vector.source.type,
  }), "utf8");
  equal(metadata.toString("utf8"), vector.metadata.canonicalUtf8, "Canonical metadata");
  equal(metadata.length, vector.metadata.bytes, "Metadata length");

  const plaintext = Buffer.alloc(vector.padding.plaintextBytes);
  for (let index = 0; index < plaintext.length; index += 1) plaintext[index] = (index * 73 + 41) & 0xff;
  plaintext.writeUInt32BE(metadata.length, 0);
  metadata.copy(plaintext, 4);
  source.copy(plaintext, 4 + metadata.length);
  equal(sha256(plaintext), vector.plaintextSha256, "Plaintext SHA-256");

  const rawKey = Buffer.from(vector.testOnlyKey.rawHex, "hex");
  equal(rawKey.length, 32, "Test key length");
  equal(`wbk1_${rawKey.toString("base64url")}`, vector.testOnlyKey.recoveryKey, "Recovery key");
  const noncePrefix = Buffer.from(vector.noncePrefixHex, "hex");
  equal(noncePrefix.length, 8, "Nonce prefix length");

  const header = Buffer.alloc(24);
  header.write("WBLMENC1", 0, "ascii");
  header.writeUInt32BE(1024 * 1024, 8);
  header.writeUInt32BE(1, 12);
  noncePrefix.copy(header, 16);
  equal(header.toString("hex"), vector.headerHex, "Header");

  const nonce = Buffer.alloc(12);
  noncePrefix.copy(nonce);
  const additionalData = Buffer.alloc(28);
  header.copy(additionalData);
  equal(additionalData.toString("hex"), vector.additionalAuthenticatedDataHex, "Additional authenticated data");

  const cipher = createCipheriv("aes-256-gcm", rawKey, nonce, { authTagLength: 16 });
  cipher.setAAD(additionalData, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  const envelope = Buffer.concat([header, ciphertext, authenticationTag]);
  try {
    equal(sha256(ciphertext), vector.ciphertextSha256, "Ciphertext SHA-256");
    equal(authenticationTag.toString("hex"), vector.authenticationTagHex, "Authentication tag");
    equal(envelope.length, vector.envelopeBytes, "Envelope length");
    equal(sha256(envelope), vector.envelopeSha256, "Envelope SHA-256");
    return {
      envelope,
      envelopeSha256: vector.envelopeSha256,
      recoveryKey: vector.testOnlyKey.recoveryKey,
      source,
      sourceName: vector.source.name,
      sourceType: vector.source.type,
    };
  } finally {
    plaintext.fill(0);
    rawKey.fill(0);
  }
}

function run() {
  const fixture = generateKnownAnswerEnvelope();
  if (process.argv[2] === "--emit") {
    process.stdout.write(`${JSON.stringify({
      envelopeBase64: fixture.envelope.toString("base64"),
      envelopeBytes: fixture.envelope.length,
      envelopeSha256: fixture.envelopeSha256,
      recoveryKey: fixture.recoveryKey,
      sourceBase64: fixture.source.toString("base64"),
      sourceName: fixture.sourceName,
      sourceType: fixture.sourceType,
    })}\n`);
    return;
  }
  if (process.argv.length > 2) throw new Error(`Unknown encryption-vector option: ${process.argv[2]}`);
  process.stdout.write(
    `Encryption vector passed: ${fixture.envelope.length} bytes, SHA-256 ${fixture.envelopeSha256}.\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) run();
