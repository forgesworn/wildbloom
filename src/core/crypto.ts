import { sha256 } from "@noble/hashes/sha2.js";
import { MAX_PROTOTYPE_FILE_BYTES, assertPrototypeFileSize, assertPrototypeTransferSize, sanitiseFileName } from "./security.js";
import {
  WILDBLOOM_ENCRYPTED_FILE_NAME,
  WILDBLOOM_ENCRYPTED_MIME_TYPE,
  WILDBLOOM_ENCRYPTION_V2,
  type EncryptionScheme,
} from "./types.js";

const HEX = "0123456789abcdef";
// Historical frames stay readable: every record authenticates the actual
// header bytes, so changing the magic without re-encrypting is rejected.
const ENVELOPE_MAGIC = new TextEncoder().encode("FSWNENC1");
const ENVELOPE_MAGIC_LEGACY = new TextEncoder().encode("WBLMENC1");
// New frames use FSWNENC2: a 56-byte header carrying a 32-byte salt, with
// the AES key derived per envelope.
const ENVELOPE_MAGIC_V2 = new TextEncoder().encode("FSWNENC2");
const ENVELOPE_HEADER_BYTES = 24;
const ENVELOPE_HEADER_BYTES_V2 = 56;
const ENVELOPE_SALT_BYTES = 32;
const HKDF_INFO_V2 = new TextEncoder().encode("forgesworn-aes-256-gcm-chunked/v2");
const ENVELOPE_CHUNK_BYTES = 1024 * 1024;
const ENVELOPE_TAG_BYTES = 16;
const MAX_ENVELOPE_METADATA_BYTES = 4096;
// The source plus its four-byte metadata length and bounded metadata occupies
// at most 257 one-MiB records. This limits decode work, not GCM nonce safety.
const MAX_ENVELOPE_RECORDS = Math.ceil(
  (MAX_PROTOTYPE_FILE_BYTES + 4 + MAX_ENVELOPE_METADATA_BYTES) / ENVELOPE_CHUNK_BYTES,
);
const MIN_PADDING_BUCKET_BYTES = 64 * 1024;
const RECOVERY_KEY_PREFIX = "wbk1_";

interface EnvelopeMetadata {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export interface EncryptedEnvelope {
  readonly file: File;
  readonly recoveryKey: string;
  readonly scheme: EncryptionScheme;
  readonly sourceName: string;
  readonly sourceSize: number;
  readonly sourceType: string;
}

function toHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += HEX.charAt(byte >>> 4) + HEX.charAt(byte & 0x0f);
  return result;
}

function assertActive(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw new Error(`${operation} cancelled.`);
}

async function updateBlobHash(
  hasher: ReturnType<typeof sha256.create>,
  blob: Blob,
  signal?: AbortSignal,
): Promise<void> {
  const reader = blob.stream().getReader();
  const abort = (): void => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      assertActive(signal, "Local hashing");
      const { done, value } = await reader.read();
      assertActive(signal, "Local hashing");
      if (done) return;
      if (value) hasher.update(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function sha256Hex(
  input: Blob | ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const hasher = sha256.create();
  if (input instanceof Blob) await updateBlobHash(hasher, input, signal);
  else {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    for (let offset = 0; offset < bytes.length; offset += ENVELOPE_CHUNK_BYTES) {
      assertActive(signal, "Local hashing");
      hasher.update(bytes.subarray(offset, offset + ENVELOPE_CHUNK_BYTES));
      await Promise.resolve();
    }
  }
  assertActive(signal, "Local hashing");
  return toHex(hasher.digest());
}

function fillRandom(bytes: Uint8Array<ArrayBuffer>): void {
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, bytes.length)));
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("The recovery key is not a Wildbloom v1 key.");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=";
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("The recovery key is not valid base64url.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.length !== 32) throw new Error("The recovery key must contain 256 bits.");
  if (base64UrlEncode(bytes) !== value) throw new Error("The recovery key is not canonical base64url.");
  return bytes;
}

function normaliseMimeType(value: string): string {
  const type = (value || "application/octet-stream").toLowerCase();
  if (type.length > 255 || /[\u0000-\u001f\u007f]/u.test(type)) throw new Error("Invalid source MIME type.");
  return type;
}

function paddedPlaintextLength(length: number): number {
  if (length <= MIN_PADDING_BUCKET_BYTES) return MIN_PADDING_BUCKET_BYTES;
  if (length <= ENVELOPE_CHUNK_BYTES) return 2 ** Math.ceil(Math.log2(length));
  return Math.ceil(length / ENVELOPE_CHUNK_BYTES) * ENVELOPE_CHUNK_BYTES;
}

function makeNonce(prefix: Uint8Array, counter: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  nonce.set(prefix);
  new DataView(nonce.buffer).setUint32(8, counter, false);
  return nonce;
}

function makeAdditionalData(header: Uint8Array, counter: number): Uint8Array<ArrayBuffer> {
  const additionalData = new Uint8Array(header.length + 4);
  additionalData.set(header);
  new DataView(additionalData.buffer).setUint32(header.length, counter, false);
  return additionalData;
}

function frameMetadata(name: string, size: number, type: string): { prefix: Uint8Array<ArrayBuffer>; metadata: EnvelopeMetadata } {
  const metadata: EnvelopeMetadata = { name: sanitiseFileName(name), size, type: normaliseMimeType(type) };
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.length > MAX_ENVELOPE_METADATA_BYTES) throw new Error("Encrypted file metadata is unexpectedly large.");
  const prefix = new Uint8Array(4 + metadataBytes.length);
  new DataView(prefix.buffer).setUint32(0, metadataBytes.length, false);
  prefix.set(metadataBytes, 4);
  metadataBytes.fill(0);
  return { prefix, metadata };
}

function assertSourceSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PROTOTYPE_FILE_BYTES) {
    throw new Error(`This version is limited to ${MAX_PROTOTYPE_FILE_BYTES / 1024 / 1024} MiB files.`);
  }
}

/**
 * The exact size of the FSWNENC2 envelope for a source of this name, type and
 * length (which may be zero), without encrypting anything. A sender can compare
 * it with a limit, and a receiver can know how many bytes to expect from the
 * manifest alone.
 */
export function envelopeBytes(name: string, type: string, sourceBytes: number): number {
  assertSourceSize(sourceBytes);
  const { prefix } = frameMetadata(name, sourceBytes, type);
  const plaintextLength = paddedPlaintextLength(prefix.length + sourceBytes);
  const recordCount = Math.ceil(plaintextLength / ENVELOPE_CHUNK_BYTES);
  return ENVELOPE_HEADER_BYTES_V2 + plaintextLength + recordCount * ENVELOPE_TAG_BYTES;
}

/**
 * A fresh `wbk1_` input key. The envelope's AES key is derived from it and the
 * header salt, so one key can seal many envelopes without ever pairing with one
 * salt twice.
 */
export function newInputKey(): string {
  const bytes = new Uint8Array(32);
  try {
    fillRandom(bytes);
    return `${RECOVERY_KEY_PREFIX}${base64UrlEncode(bytes)}`;
  } finally {
    bytes.fill(0);
  }
}

/**
 * Decodes a `wbk1_` input key to its 32 bytes, refusing anything that is not
 * the canonical unpadded base64url form. The caller owns, and should zero, the
 * returned bytes.
 */
export function parseInputKey(value: string): Uint8Array<ArrayBuffer> {
  if (!value.startsWith(RECOVERY_KEY_PREFIX)) throw new Error("The recovery key is not a Wildbloom v1 key.");
  return base64UrlDecode(value.slice(RECOVERY_KEY_PREFIX.length));
}

/**
 * Where an encoder gets its randomness. The default is the browser's random
 * source. A test supplies fixed values to reproduce a known-answer envelope.
 */
export interface EnvelopeEntropy {
  /** The 8-byte nonce prefix. */
  noncePrefix(): Uint8Array<ArrayBuffer>;
  /** The 32-byte header salt. */
  salt(): Uint8Array<ArrayBuffer>;
  /** A fresh 32-byte input key, asked for only when none was supplied. */
  inputKey(): Uint8Array<ArrayBuffer>;
  /** Fills padding: `target` holds the plaintext bytes from `plaintextOffset`. Only padding is ever asked for. */
  padding(target: Uint8Array<ArrayBuffer>, plaintextOffset: number): void;
}

const RANDOM_ENTROPY: EnvelopeEntropy = {
  noncePrefix(): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(8);
    fillRandom(bytes);
    return bytes;
  },
  salt(): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(ENVELOPE_SALT_BYTES);
    fillRandom(bytes);
    return bytes;
  },
  inputKey(): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(32);
    fillRandom(bytes);
    return bytes;
  },
  padding(target): void {
    fillRandom(target);
  },
};

export interface EnvelopeEncoderOptions {
  /** A `wbk1_` input key; a fresh one is made when absent. */
  readonly key?: string;
  readonly signal?: AbortSignal;
  readonly entropy?: EnvelopeEntropy;
}

/**
 * An FSWNENC2 envelope made one record at a time, so a large source never sits
 * in memory whole: `header`, then each record from `next()`, in order. Memory is
 * one plaintext record, one ciphertext record and the caller's own buffering,
 * whatever the source size.
 */
export interface EnvelopeEncoder {
  /** The 56-byte header; it comes before the first record on the wire. */
  readonly header: Uint8Array<ArrayBuffer>;
  readonly recordCount: number;
  /** The whole envelope: header, every record and every tag. */
  readonly envelopeBytes: number;
  /** The metadata that is sealed into the envelope, with the name as the sanitiser leaves it. */
  readonly metadata: Readonly<EnvelopeMetadata>;
  /** The input key, as it was supplied or made. */
  readonly inputKey: string;
  /** The next record (ciphertext and tag), or undefined after the last. Call it once at a time. */
  next(): Promise<Uint8Array<ArrayBuffer> | undefined>;
  /** The SHA-256 of the source bytes, once every record has been made. */
  digest(): Uint8Array<ArrayBuffer>;
  /** Forgets the key material. Safe to repeat. */
  dispose(): void;
}

export async function createEnvelopeEncoder(
  source: Blob,
  describe: { readonly name: string; readonly type: string },
  options: EnvelopeEncoderOptions = {},
): Promise<EnvelopeEncoder> {
  const { signal } = options;
  const entropy = options.entropy ?? RANDOM_ENTROPY;
  assertActive(signal, "Local encryption");
  assertSourceSize(source.size);
  // Validate a supplied key before any work, and never keep its bytes longer than the derivation.
  const suppliedBytes = options.key === undefined ? undefined : parseInputKey(options.key);
  let framed: ReturnType<typeof frameMetadata>;
  try {
    framed = frameMetadata(describe.name, source.size, describe.type);
  } catch (error) {
    suppliedBytes?.fill(0);
    throw error;
  }
  const { prefix, metadata } = framed;
  const fileStart = prefix.length;
  const fileEnd = fileStart + source.size;
  const plaintextLength = paddedPlaintextLength(fileEnd);
  const recordCount = Math.ceil(plaintextLength / ENVELOPE_CHUNK_BYTES);
  const noncePrefix = entropy.noncePrefix();
  const salt = entropy.salt();
  const header = new Uint8Array(ENVELOPE_HEADER_BYTES_V2);
  header.set(ENVELOPE_MAGIC_V2);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(8, ENVELOPE_CHUNK_BYTES, false);
  headerView.setUint32(12, recordCount, false);
  header.set(noncePrefix, 16);
  header.set(salt, 24);

  // The input key stays the per-file key; the AES key is derived from it and the
  // header salt with HKDF-SHA256, so no two envelopes share a key.
  const rawKey = suppliedBytes ?? entropy.inputKey();
  let key: CryptoKey;
  let inputKey: string;
  try {
    const baseKey = await crypto.subtle.importKey("raw", rawKey, "HKDF", false, ["deriveBits"]);
    const derived = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO_V2 },
      baseKey,
      256,
    ));
    try {
      key = await crypto.subtle.importKey("raw", derived, "AES-GCM", false, ["encrypt"]);
    } finally {
      derived.fill(0);
    }
    inputKey = `${RECOVERY_KEY_PREFIX}${base64UrlEncode(rawKey)}`;
  } catch (error) {
    prefix.fill(0);
    throw error;
  } finally {
    rawKey.fill(0);
  }

  const hasher = sha256.create();
  let counter = 0;
  let busy = false;
  let digest: Uint8Array<ArrayBuffer> | undefined;

  async function plaintextRecord(index: number): Promise<Uint8Array<ArrayBuffer>> {
    const offset = index * ENVELOPE_CHUNK_BYTES;
    const length = Math.min(ENVELOPE_CHUNK_BYTES, plaintextLength - offset);
    const chunk = new Uint8Array(length);
    try {
      const prefixEnd = Math.min(offset + length, fileStart);
      if (prefixEnd > offset) chunk.set(prefix.subarray(offset, prefixEnd), 0);
      const overlapStart = Math.max(offset, fileStart);
      const overlapEnd = Math.min(offset + length, fileEnd);
      if (overlapEnd > overlapStart) {
        const wanted = overlapEnd - overlapStart;
        const slice = new Uint8Array(await source.slice(overlapStart - fileStart, overlapEnd - fileStart).arrayBuffer());
        try {
          assertActive(signal, "Local encryption");
          if (slice.length !== wanted) throw new Error("The file changed while it was being read.");
          hasher.update(slice);
          chunk.set(slice, overlapStart - offset);
        } finally {
          slice.fill(0);
        }
      }
      // Only the tail past the source is padding; the rest was just written.
      const paddingStart = Math.max(offset, fileEnd);
      if (paddingStart < offset + length) entropy.padding(chunk.subarray(paddingStart - offset), paddingStart);
      return chunk;
    } catch (error) {
      chunk.fill(0);
      throw error;
    }
  }

  return {
    header,
    recordCount,
    envelopeBytes: ENVELOPE_HEADER_BYTES_V2 + plaintextLength + recordCount * ENVELOPE_TAG_BYTES,
    metadata,
    inputKey,
    async next(): Promise<Uint8Array<ArrayBuffer> | undefined> {
      if (busy) throw new Error("The encoder makes one record at a time.");
      if (counter >= recordCount) return undefined;
      busy = true;
      try {
        assertActive(signal, "Local encryption");
        const index = counter;
        const plaintext = await plaintextRecord(index);
        let ciphertext: ArrayBuffer;
        try {
          ciphertext = await crypto.subtle.encrypt({
            name: "AES-GCM",
            iv: makeNonce(noncePrefix, index),
            additionalData: makeAdditionalData(header, index),
            tagLength: 128,
          }, key, plaintext);
        } finally {
          plaintext.fill(0);
        }
        assertActive(signal, "Local encryption");
        counter += 1;
        if (counter === recordCount) digest = hasher.digest() as Uint8Array<ArrayBuffer>;
        return new Uint8Array(ciphertext);
      } finally {
        busy = false;
      }
    },
    digest(): Uint8Array<ArrayBuffer> {
      if (!digest) throw new Error("The digest is known only after the last record.");
      return digest.slice();
    },
    dispose(): void {
      prefix.fill(0);
    },
  };
}

export async function encryptPrivacyEnvelope(file: File, signal?: AbortSignal): Promise<EncryptedEnvelope> {
  assertActive(signal, "Local encryption");
  assertPrototypeFileSize(file.size);
  const encoder = await createEnvelopeEncoder(file, { name: file.name, type: file.type }, signal ? { signal } : {});
  try {
    const parts: BlobPart[] = [encoder.header];
    for (let record = await encoder.next(); record; record = await encoder.next()) parts.push(record);
    const encrypted = new File(parts, WILDBLOOM_ENCRYPTED_FILE_NAME, {
      type: WILDBLOOM_ENCRYPTED_MIME_TYPE,
      lastModified: 0,
    });
    assertPrototypeTransferSize(encrypted.size);
    return {
      file: encrypted,
      recoveryKey: encoder.inputKey,
      scheme: WILDBLOOM_ENCRYPTION_V2,
      sourceName: encoder.metadata.name,
      sourceSize: encoder.metadata.size,
      sourceType: encoder.metadata.type,
    };
  } finally {
    encoder.dispose();
  }
}

async function parseEnvelopeHeader(file: Blob, signal?: AbortSignal): Promise<{
  header: Uint8Array;
  headerBytes: number;
  chunkSize: number;
  recordCount: number;
  noncePrefix: Uint8Array;
  salt: Uint8Array<ArrayBuffer> | null;
}> {
  assertActive(signal, "Local decryption");
  // The magic is the version field. FSWNENC2 carries a 32-byte salt, so its
  // header is 56 bytes; FSWNENC1 and legacy WBLMENC1 use the 24-byte header.
  const magic = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const magicMatches = (candidate: Uint8Array): boolean => candidate.every((byte, index) => magic[index] === byte);
  const isV2 = magicMatches(ENVELOPE_MAGIC_V2);
  if (magic.length !== 8 || (!isV2 && !magicMatches(ENVELOPE_MAGIC) && !magicMatches(ENVELOPE_MAGIC_LEGACY))) {
    throw new Error("This is not a Wildbloom encrypted envelope.");
  }
  const headerBytes = isV2 ? ENVELOPE_HEADER_BYTES_V2 : ENVELOPE_HEADER_BYTES;
  const header = new Uint8Array(await file.slice(0, headerBytes).arrayBuffer());
  assertActive(signal, "Local decryption");
  if (header.length !== headerBytes) throw new Error("This is not a Wildbloom encrypted envelope.");
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const chunkSize = view.getUint32(8, false);
  const recordCount = view.getUint32(12, false);
  if (chunkSize !== ENVELOPE_CHUNK_BYTES || recordCount < 1 || recordCount > MAX_ENVELOPE_RECORDS) {
    throw new Error("The Wildbloom envelope header is invalid.");
  }
  const minimumSize = headerBytes
    + (recordCount - 1) * (chunkSize + ENVELOPE_TAG_BYTES)
    + 1 + ENVELOPE_TAG_BYTES;
  const maximumSize = headerBytes + recordCount * (chunkSize + ENVELOPE_TAG_BYTES);
  if (file.size < minimumSize || file.size > maximumSize) throw new Error("The Wildbloom envelope length is invalid.");
  const salt = isV2 ? Uint8Array.from(header.subarray(24, 24 + ENVELOPE_SALT_BYTES)) : null;
  return { header, headerBytes, chunkSize, recordCount, noncePrefix: header.slice(16, 24), salt };
}

function parseEnvelopeMetadata(plaintext: Uint8Array): { metadata: EnvelopeMetadata; prefixLength: number } {
  if (plaintext.length < 4) throw new Error("The encrypted metadata record is truncated.");
  const metadataLength = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0, false);
  if (metadataLength < 2 || metadataLength > MAX_ENVELOPE_METADATA_BYTES || 4 + metadataLength > plaintext.length) {
    throw new Error("The encrypted metadata length is invalid.");
  }
  let value: unknown;
  let metadataText: string;
  try {
    metadataText = new TextDecoder("utf-8", { fatal: true }).decode(plaintext.subarray(4, 4 + metadataLength));
    value = JSON.parse(metadataText);
  } catch {
    throw new Error("The encrypted metadata is invalid.");
  }
  if (!value || typeof value !== "object") throw new Error("The encrypted metadata is invalid.");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || typeof candidate.size !== "number" || typeof candidate.type !== "string") {
    throw new Error("The encrypted metadata types are invalid.");
  }
  const name = sanitiseFileName(String(candidate.name ?? ""));
  if (name !== candidate.name) throw new Error("The encrypted filename is invalid.");
  const size = Number(candidate.size);
  assertPrototypeFileSize(size);
  const type = normaliseMimeType(String(candidate.type ?? ""));
  if (Object.keys(candidate).sort().join(",") !== "name,size,type") throw new Error("The encrypted metadata shape is invalid.");
  if (metadataText !== JSON.stringify({ name, size, type })) throw new Error("The encrypted metadata is not canonical.");
  return { metadata: { name, size, type }, prefixLength: 4 + metadataLength };
}

export async function decryptPrivacyEnvelope(
  file: Blob,
  recoveryKey: string,
  signal?: AbortSignal,
): Promise<File> {
  assertActive(signal, "Local decryption");
  assertPrototypeTransferSize(file.size);
  if (!recoveryKey.startsWith(RECOVERY_KEY_PREFIX)) throw new Error("The recovery key is not a Wildbloom v1 key.");
  const { header, headerBytes, chunkSize, recordCount, noncePrefix, salt } = await parseEnvelopeHeader(file, signal);
  // Do not materialise mutable key bytes until the untrusted header has passed:
  // a malformed header must not bypass their finally-block erasure below.
  const rawKey = base64UrlDecode(recoveryKey.slice(RECOVERY_KEY_PREFIX.length));
  let key: CryptoKey;
  try {
    if (salt) {
      // FSWNENC2: derive the AES key per envelope from the recovery key and the
      // header salt with HKDF-SHA256 and a fixed info label.
      const baseKey = await crypto.subtle.importKey("raw", rawKey, "HKDF", false, ["deriveBits"]);
      const derived = new Uint8Array(await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO_V2 },
        baseKey,
        256,
      ));
      try {
        key = await crypto.subtle.importKey("raw", derived, "AES-GCM", false, ["decrypt"]);
      } finally {
        derived.fill(0);
      }
    } else {
      key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    }
  } finally {
    rawKey.fill(0);
  }
  const plaintextLength = file.size - headerBytes - recordCount * ENVELOPE_TAG_BYTES;

  let metadata: EnvelopeMetadata | null = null;
  let prefixLength = 0;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let copied = 0;
  try {
    for (let counter = 0; counter < recordCount; counter += 1) {
      assertActive(signal, "Local decryption");
      const ciphertextStart = headerBytes + counter * (chunkSize + ENVELOPE_TAG_BYTES);
      const ciphertextEnd = counter === recordCount - 1 ? file.size : ciphertextStart + chunkSize + ENVELOPE_TAG_BYTES;
      const ciphertext = await file.slice(ciphertextStart, ciphertextEnd).arrayBuffer();
      assertActive(signal, "Local decryption");
      let plaintext: Uint8Array<ArrayBuffer>;
      try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt({
          name: "AES-GCM",
          iv: makeNonce(noncePrefix, counter),
          additionalData: makeAdditionalData(header, counter),
          tagLength: 128,
        }, key, ciphertext));
      } catch {
        throw new Error("The recovery key is wrong or the encrypted envelope was modified.");
      }
      try {
        assertActive(signal, "Local decryption");
        if (!metadata) {
          const parsed = parseEnvelopeMetadata(plaintext);
          metadata = parsed.metadata;
          prefixLength = parsed.prefixLength;
          if (paddedPlaintextLength(prefixLength + metadata.size) !== plaintextLength) {
            throw new Error("The encrypted envelope padding is invalid.");
          }
        }

        const globalStart = counter * chunkSize;
        const wantedStart = prefixLength;
        const wantedEnd = prefixLength + metadata.size;
        const overlapStart = Math.max(globalStart, wantedStart);
        const overlapEnd = Math.min(globalStart + plaintext.length, wantedEnd);
        if (overlapEnd > overlapStart) {
          const part = plaintext.slice(overlapStart - globalStart, overlapEnd - globalStart);
          copied += part.length;
          parts.push(part);
        }
      } finally {
        plaintext.fill(0);
      }
    }
    if (!metadata || copied !== metadata.size) throw new Error("The encrypted envelope did not contain the declared file.");
    assertActive(signal, "Local decryption");
    const recovered = new File(parts, metadata.name, { type: metadata.type, lastModified: 0 });
    for (const part of parts) part.fill(0);
    return recovered;
  } catch (error) {
    for (const part of parts) part.fill(0);
    throw error;
  }
}
