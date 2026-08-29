// Generates the language-neutral negative-vector suite for the encryption
// envelope: a set of tampered FSWNENC1 envelopes, each with the rejection
// category a conformant decoder MUST report. A second implementation runs the
// same base64 envelopes through its own decoder and asserts the same category,
// which is how adversarial parity is proved across implementations.
//
// Run `node scripts/encryption-negative-vector.mjs` to regenerate
// test-vectors/encryption-negative.json. The unit suite
// (tests/encryption-negative.test.ts) then asserts the reference decoder
// rejects every case and accepts the single control.

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

import {
  generateV2KnownAnswerEnvelope,
  generateV2MultiRecordKnownAnswerEnvelope,
} from "./encryption-vector.mjs";

const HEADER_BYTES = 24;
const TAG_BYTES = 16;

function clone(buffer, mutate) {
  const copy = Buffer.from(buffer);
  mutate(copy);
  return copy;
}

function build() {
  const one = generateV2KnownAnswerEnvelope();
  const two = generateV2MultiRecordKnownAnswerEnvelope();
  const key = one.recoveryKey;
  const otherKey = two.recoveryKey; // a different, valid key
  const b64 = (buffer) => buffer.toString("base64");

  // Record boundaries of the two-record envelope, read from its own header.
  const chunkSize = two.envelope.readUInt32BE(8);
  const tag0Offset = HEADER_BYTES + chunkSize; // first record is a full chunk
  const tag1Offset = two.envelope.length - TAG_BYTES;

  const cases = [
    {
      id: "control-valid",
      category: "none",
      description: "the unmodified FSWNENC1 one-record envelope decrypts",
      recoveryKey: key,
      envelopeBase64: b64(one.envelope),
    },
    {
      id: "bad-magic",
      category: "magic",
      description: "first magic byte flipped, so it is neither FSWNENC1 nor WBLMENC1",
      recoveryKey: key,
      envelopeBase64: b64(clone(one.envelope, (b) => { b[0] ^= 0x01; })),
    },
    {
      id: "bad-chunk-size",
      category: "header",
      description: "the clear chunk-size field is not the expected 1 MiB",
      recoveryKey: key,
      envelopeBase64: b64(clone(one.envelope, (b) => { b[8] ^= 0x01; })),
    },
    {
      id: "zero-record-count",
      category: "header",
      description: "the record count is set to zero",
      recoveryKey: key,
      envelopeBase64: b64(clone(one.envelope, (b) => { b.writeUInt32BE(0, 12); })),
    },
    {
      id: "flipped-tag",
      category: "authentication",
      description: "a byte of the GCM authentication tag is flipped",
      recoveryKey: key,
      envelopeBase64: b64(clone(one.envelope, (b) => { b[b.length - 1] ^= 0x01; })),
    },
    {
      id: "flipped-ciphertext",
      category: "authentication",
      description: "a ciphertext body byte is flipped",
      recoveryKey: key,
      envelopeBase64: b64(clone(one.envelope, (b) => { b[HEADER_BYTES + 6] ^= 0x01; })),
    },
    {
      id: "altered-nonce-prefix",
      category: "authentication",
      description: "the header nonce prefix is altered, which both moves the nonce and breaks the AAD",
      recoveryKey: key,
      envelopeBase64: b64(clone(one.envelope, (b) => { b[16] ^= 0x01; })),
    },
    {
      id: "truncated",
      category: "length-or-authentication",
      description: "the final byte is removed",
      recoveryKey: key,
      envelopeBase64: b64(one.envelope.subarray(0, one.envelope.length - 1)),
    },
    {
      id: "appended",
      category: "length-or-authentication",
      description: "an extra byte is appended",
      recoveryKey: key,
      envelopeBase64: b64(Buffer.concat([one.envelope, Buffer.from([0x00])])),
    },
    {
      id: "record-tags-swapped",
      category: "authentication",
      description: "the two records' authentication tags are swapped, which the position-bound AAD rejects",
      recoveryKey: two.recoveryKey,
      envelopeBase64: b64(clone(two.envelope, (b) => {
        const tag0 = Buffer.from(b.subarray(tag0Offset, tag0Offset + TAG_BYTES));
        const tag1 = Buffer.from(b.subarray(tag1Offset, tag1Offset + TAG_BYTES));
        tag1.copy(b, tag0Offset);
        tag0.copy(b, tag1Offset);
      })),
    },
    {
      id: "wrong-key",
      category: "authentication",
      description: "a valid envelope decrypted under a different, valid key",
      recoveryKey: otherKey,
      envelopeBase64: b64(one.envelope),
    },
    {
      id: "malformed-recovery-key",
      category: "recovery-key",
      description: "the recovery key is not canonical unpadded base64url for 32 bytes",
      recoveryKey: "wbk1_this-is-not-a-valid-key",
      envelopeBase64: b64(one.envelope),
    },
  ];

  return {
    format: "wildbloom-encryption-negative-v1",
    scheme: "wildbloom-aes-256-gcm-chunked-v1",
    note: "Each case except control-valid MUST be rejected. The category is the "
      + "rejection class a conformant decoder reports; message text is "
      + "implementation-defined. Envelopes carry the FSWNENC1 magic.",
    categories: {
      none: "decrypts successfully",
      magic: "the eight magic bytes are neither FSWNENC1 nor WBLMENC1",
      header: "the chunk size or record count is out of range",
      "length-or-authentication": "the body length is inconsistent, or a record fails to authenticate",
      authentication: "a record's GCM tag fails under its position-bound AAD",
      "recovery-key": "the recovery key is not canonical",
    },
    cases,
  };
}

function run() {
  const suite = build();
  const target = fileURLToPath(new URL("../test-vectors/encryption-negative.json", import.meta.url));
  writeFileSync(target, `${JSON.stringify(suite, null, 2)}\n`);
  process.stdout.write(`Wrote ${suite.cases.length} negative vectors to ${target}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) run();

export { build };
