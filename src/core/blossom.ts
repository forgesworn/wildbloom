import { sha256Hex } from "./crypto.js";
import { buildUploadAuthorisation, encodeNostrAuthorisation, signEventExactly, validateBlobDescriptor } from "./nostr.js";
import {
  assertHex64,
  assertPrototypeFileSize,
  assertPrototypeTransferSize,
  fileExtension,
  normaliseBlossomServer,
  normaliseBlossomUrl,
  safeDiagnostic,
  sanitiseFileName,
} from "./security.js";
import type { BlobDescriptor, InspectedFile, NetworkProfile, ResolvedHybridEvent, SignerPort } from "./types.js";

type FetchPort = typeof fetch;

export async function inspectFile(file: File, purpose: "source" | "transfer" = "source"): Promise<InspectedFile> {
  if (purpose === "source") assertPrototypeFileSize(file.size);
  else assertPrototypeTransferSize(file.size);
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

export function buildBlossomUri(
  file: InspectedFile,
  server: string,
  pubkey: string,
  profile: NetworkProfile = "direct",
): string {
  const hostname = new URL(normaliseBlossomServer(server, profile)).hostname;
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
  profile: NetworkProfile = "direct",
): Promise<BlobDescriptor> {
  const server = normaliseBlossomServer(serverInput, profile);
  const template = buildUploadAuthorisation(inspected.sha256, server, undefined, undefined, profile);
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
    redirect: "error",
  });
  if (response.status !== 200 && response.status !== 201) {
    const reason = safeDiagnostic(response.headers.get("X-Reason") || response.statusText || `HTTP ${response.status}`);
    throw new Error(`Blossom upload failed: ${reason}`);
  }
  const text = await readTextCapped(response, 64 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Blossom returned a non-JSON descriptor.");
  }
  const descriptor = validateBlobDescriptor(parsed, inspected, profile);
  if (new URL(descriptor.url).origin !== server) {
    throw new Error("Blossom moved the payload to an unapproved origin.");
  }
  return descriptor;
}

async function readTextCapped(response: Response, maximumBytes: number): Promise<string> {
  const advertised = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(advertised) && advertised > maximumBytes) {
    throw new Error("Blossom descriptor response is unexpectedly large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel("descriptor too large");
        throw new Error("Blossom descriptor response is unexpectedly large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) throw new Error("Blossom descriptor is not valid UTF-8.");
    throw error;
  }
  return text;
}

export async function fetchVerifiedBlob(
  resolved: ResolvedHybridEvent,
  fetchImpl: FetchPort = fetch,
  profile: NetworkProfile = "direct",
): Promise<Blob> {
  const url = normaliseBlossomUrl(resolved.url, resolved.sha256, profile);
  const response = await fetchImpl(url, {
    method: "GET",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Blossom retrieval failed: ${safeDiagnostic(response.statusText || `HTTP ${response.status}`)}`);
  if (response.url && response.url !== url) throw new Error("Blossom retrieval changed URL unexpectedly.");

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
