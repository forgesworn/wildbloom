import { sha256Hex } from "./crypto.js";
import { buildUploadAuthorisation, encodeNostrAuthorisation, signEventExactly, validateBlobDescriptor } from "./nostr.js";
import {
  assertHex64,
  assertPrototypeFileSize,
  fileExtension,
  normaliseBlossomServer,
  normaliseBlossomUrl,
  safeDiagnostic,
  sanitiseFileName,
} from "./security.js";
import type { BlobDescriptor, InspectedFile, ResolvedHybridEvent, SignerPort } from "./types.js";

type FetchPort = typeof fetch;

export async function inspectFile(file: File): Promise<InspectedFile> {
  assertPrototypeFileSize(file.size);
  const name = sanitiseFileName(file.name);
  return {
    file,
    name,
    extension: fileExtension(name),
    sha256: await sha256Hex(file),
    size: file.size,
    type: (file.type || "application/octet-stream").toLowerCase(),
  };
}

export function buildBlossomUri(file: InspectedFile, server: string, pubkey: string): string {
  const hostname = new URL(normaliseBlossomServer(server)).hostname;
  const query = new URLSearchParams();
  query.append("xs", hostname);
  query.append("as", assertHex64(pubkey, "Author public key"));
  query.set("sz", String(file.size));
  return `blossom:${file.sha256}.${file.extension}?${query.toString()}`;
}

export async function uploadToBlossom(
  inspected: InspectedFile,
  serverInput: string,
  signer: SignerPort,
  pubkey: string,
  fetchImpl: FetchPort = fetch,
): Promise<BlobDescriptor> {
  const server = normaliseBlossomServer(serverInput);
  const template = buildUploadAuthorisation(inspected.sha256, server);
  const authorisation = await signEventExactly(template, signer, pubkey);
  const response = await fetchImpl(`${server}/upload`, {
    method: "PUT",
    headers: {
      Authorization: encodeNostrAuthorisation(authorisation),
      "Content-Type": inspected.type,
      "X-SHA-256": inspected.sha256,
    },
    body: inspected.file,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  });
  if (response.status !== 200 && response.status !== 201) {
    const reason = safeDiagnostic(response.headers.get("X-Reason") || response.statusText || `HTTP ${response.status}`);
    throw new Error(`Blossom upload failed: ${reason}`);
  }
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error("Blossom descriptor response is unexpectedly large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Blossom returned a non-JSON descriptor.");
  }
  return validateBlobDescriptor(parsed, inspected);
}

export async function fetchVerifiedBlob(
  resolved: ResolvedHybridEvent,
  fetchImpl: FetchPort = fetch,
): Promise<Blob> {
  const url = normaliseBlossomUrl(resolved.url, resolved.sha256);
  const response = await fetchImpl(url, {
    method: "GET",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Blossom retrieval failed: ${safeDiagnostic(response.statusText || `HTTP ${response.status}`)}`);
  if (response.url) normaliseBlossomUrl(response.url, resolved.sha256);

  const advertisedLength = response.headers.get("Content-Length");
  if (advertisedLength !== null && Number(advertisedLength) !== resolved.size) {
    throw new Error("Blossom advertised a byte count that differs from the signed event.");
  }
  if (!response.body) throw new Error("Blossom response has no readable body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > resolved.size) {
      await reader.cancel("response larger than signed size");
      throw new Error("Blossom returned more bytes than the signed event permits.");
    }
    chunks.push(value);
  }
  if (received !== resolved.size) throw new Error("Blossom returned fewer bytes than the signed event declares.");
  const blob = new Blob(chunks as BlobPart[], { type: resolved.mimeType });
  if (await sha256Hex(blob) !== resolved.sha256) throw new Error("Blossom bytes failed SHA-256 verification.");
  return blob;
}
