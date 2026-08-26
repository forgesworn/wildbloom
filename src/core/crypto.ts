import { sha256 } from "@noble/hashes/sha2.js";
import { assertPrototypeFileSize, assertPrototypeTransferSize, sanitiseFileName } from "./security.js";
import { WILDBLOOM_ENCRYPTION, type EncryptionScheme } from "./types.js";

const HEX = "0123456789abcdef";
const ENVELOPE_MAGIC = new TextEncoder().encode("WBLMENC1");
const ENVELOPE_HEADER_BYTES = 24;
const ENVELOPE_CHUNK_BYTES = 1024 * 1024;
const ENVELOPE_TAG_BYTES = 16;
const MAX_ENVELOPE_METADATA_BYTES = 4096;
const MIN_PADDING_BUCKET_BYTES = 64 * 1024;
const RECOVERY_KEY_PREFIX = "wbk1_";
const PUBLIC_ENVELOPE_NAME = "wildbloom.wbenc";
const PUBLIC_ENVELOPE_TYPE = "application/vnd.wildbloom.encrypted";

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

async function updateBlobHash(hasher: ReturnType<typeof sha256.create>, blob: Blob): Promise<void> {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) hasher.update(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function sha256Hex(input: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const hasher = sha256.create();
  if (input instanceof Blob) await updateBlobHash(hasher, input);
  else if (input instanceof Uint8Array) hasher.update(input);
  else hasher.update(new Uint8Array(input));
  return toHex(hasher.digest());
}

function fillRandom(bytes: Uint8Array): void {
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    const random = crypto.getRandomValues(new Uint8Array(Math.min(65_536, bytes.length - offset)));
    bytes.set(random, offset);
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

async function makePlaintextChunk(
  file: File,
  prefix: Uint8Array,
  offset: number,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunk = new Uint8Array(length);
  fillRandom(chunk);
  const prefixStart = Math.max(offset, 0);
  const prefixEnd = Math.min(offset + length, prefix.length);
  if (prefixEnd > prefixStart) chunk.set(prefix.subarray(prefixStart, prefixEnd), prefixStart - offset);

  const fileStart = prefix.length;
  const overlapStart = Math.max(offset, fileStart);
  const overlapEnd = Math.min(offset + length, fileStart + file.size);
  if (overlapEnd > overlapStart) {
    const sourceStart = overlapStart - fileStart;
    const sourceEnd = overlapEnd - fileStart;
    const source = new Uint8Array(await file.slice(sourceStart, sourceEnd).arrayBuffer());
    chunk.set(source, overlapStart - offset);
  }
  return chunk;
}

export async function encryptPrivacyEnvelope(file: File): Promise<EncryptedEnvelope> {
  assertPrototypeFileSize(file.size);
  const metadata: EnvelopeMetadata = {
    name: sanitiseFileName(file.name),
    size: file.size,
    type: normaliseMimeType(file.type),
  };
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.length > MAX_ENVELOPE_METADATA_BYTES) throw new Error("Encrypted file metadata is unexpectedly large.");
  const prefix = new Uint8Array(4 + metadataBytes.length);
  new DataView(prefix.buffer).setUint32(0, metadataBytes.length, false);
  prefix.set(metadataBytes, 4);

  const plaintextLength = paddedPlaintextLength(prefix.length + file.size);
  const recordCount = Math.ceil(plaintextLength / ENVELOPE_CHUNK_BYTES);
  const noncePrefix = new Uint8Array(8);
  fillRandom(noncePrefix);
  const header = new Uint8Array(ENVELOPE_HEADER_BYTES);
  header.set(ENVELOPE_MAGIC);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(8, ENVELOPE_CHUNK_BYTES, false);
  headerView.setUint32(12, recordCount, false);
  header.set(noncePrefix, 16);

  const rawKey = new Uint8Array(32);
  fillRandom(rawKey);
  const recoveryKey = `${RECOVERY_KEY_PREFIX}${base64UrlEncode(rawKey)}`;
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  rawKey.fill(0);

  const parts: BlobPart[] = [header];
  for (let counter = 0; counter < recordCount; counter += 1) {
    const offset = counter * ENVELOPE_CHUNK_BYTES;
    const length = Math.min(ENVELOPE_CHUNK_BYTES, plaintextLength - offset);
    const plaintext = await makePlaintextChunk(file, prefix, offset, length);
    const ciphertext = await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: makeNonce(noncePrefix, counter),
      additionalData: makeAdditionalData(header, counter),
      tagLength: 128,
    }, key, plaintext);
    plaintext.fill(0);
    parts.push(ciphertext);
  }

  const encrypted = new File(parts, PUBLIC_ENVELOPE_NAME, { type: PUBLIC_ENVELOPE_TYPE, lastModified: 0 });
  assertPrototypeTransferSize(encrypted.size);
  return {
    file: encrypted,
    recoveryKey,
    scheme: WILDBLOOM_ENCRYPTION,
    sourceName: metadata.name,
    sourceSize: metadata.size,
    sourceType: metadata.type,
  };
}

async function parseEnvelopeHeader(file: Blob): Promise<{
  header: Uint8Array;
  chunkSize: number;
  recordCount: number;
  noncePrefix: Uint8Array;
}> {
  const header = new Uint8Array(await file.slice(0, ENVELOPE_HEADER_BYTES).arrayBuffer());
  if (header.length !== ENVELOPE_HEADER_BYTES || ENVELOPE_MAGIC.some((byte, index) => header[index] !== byte)) {
    throw new Error("This is not a Wildbloom encrypted envelope.");
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const chunkSize = view.getUint32(8, false);
  const recordCount = view.getUint32(12, false);
  if (chunkSize !== ENVELOPE_CHUNK_BYTES || recordCount < 1 || recordCount > 258) {
    throw new Error("The Wildbloom envelope header is invalid.");
  }
  const minimumSize = ENVELOPE_HEADER_BYTES
    + (recordCount - 1) * (chunkSize + ENVELOPE_TAG_BYTES)
    + 1 + ENVELOPE_TAG_BYTES;
  const maximumSize = ENVELOPE_HEADER_BYTES + recordCount * (chunkSize + ENVELOPE_TAG_BYTES);
  if (file.size < minimumSize || file.size > maximumSize) throw new Error("The Wildbloom envelope length is invalid.");
  return { header, chunkSize, recordCount, noncePrefix: header.slice(16, 24) };
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

export async function decryptPrivacyEnvelope(file: Blob, recoveryKey: string): Promise<File> {
  assertPrototypeTransferSize(file.size);
  if (!recoveryKey.startsWith(RECOVERY_KEY_PREFIX)) throw new Error("The recovery key is not a Wildbloom v1 key.");
  const rawKey = base64UrlDecode(recoveryKey.slice(RECOVERY_KEY_PREFIX.length));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  rawKey.fill(0);
  const { header, chunkSize, recordCount, noncePrefix } = await parseEnvelopeHeader(file);
  const plaintextLength = file.size - ENVELOPE_HEADER_BYTES - recordCount * ENVELOPE_TAG_BYTES;

  let metadata: EnvelopeMetadata | null = null;
  let prefixLength = 0;
  const parts: BlobPart[] = [];
  let copied = 0;
  for (let counter = 0; counter < recordCount; counter += 1) {
    const ciphertextStart = ENVELOPE_HEADER_BYTES + counter * (chunkSize + ENVELOPE_TAG_BYTES);
    const ciphertextEnd = counter === recordCount - 1 ? file.size : ciphertextStart + chunkSize + ENVELOPE_TAG_BYTES;
    const ciphertext = await file.slice(ciphertextStart, ciphertextEnd).arrayBuffer();
    let plaintext: Uint8Array;
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
    if (!metadata) {
      const parsed = parseEnvelopeMetadata(plaintext);
      metadata = parsed.metadata;
      prefixLength = parsed.prefixLength;
      if (paddedPlaintextLength(prefixLength + metadata.size) !== plaintextLength) {
        plaintext.fill(0);
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
    plaintext.fill(0);
  }
  if (!metadata || copied !== metadata.size) throw new Error("The encrypted envelope did not contain the declared file.");
  return new File(parts, metadata.name, { type: metadata.type, lastModified: 0 });
}
