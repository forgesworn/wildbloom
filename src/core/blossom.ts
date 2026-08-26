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
const BLOSSOM_OPERATION_TIMEOUT_MS = 30 * 60 * 1000;

export interface BlossomRequestOptions {
  readonly fetchImpl?: FetchPort;
  readonly profile?: NetworkProfile;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly authorisationLifetimeSeconds?: number;
}

function requestDeadline(options: BlossomRequestOptions, operation: "upload" | "retrieval") {
  const timeoutMs = options.timeoutMs ?? BLOSSOM_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Blossom timeout must be a positive integer.");
  const controller = new AbortController();
  let timedOut = false;
  const cancel = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Blossom ${operation} timed out.`, "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    explain(error: unknown): Error {
      if (timedOut) return new Error(`Blossom ${operation} timed out.`);
      if (options.signal?.aborted) return new Error(`Blossom ${operation} cancelled.`);
      return error instanceof Error ? error : new Error(safeDiagnostic(error));
    },
    dispose(): void {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    },
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Operation aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(signal.reason ?? new DOMException("Operation aborted.", "AbortError")));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function inspectFile(
  file: File,
  purpose: "source" | "transfer" = "source",
  signal?: AbortSignal,
): Promise<InspectedFile> {
  if (purpose === "source") assertPrototypeFileSize(file.size);
  else assertPrototypeTransferSize(file.size);
  const name = sanitiseFileName(file.name);
  return {
    file,
    name,
    extension: fileExtension(name),
    sha256: await sha256Hex(file, signal),
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
  options: BlossomRequestOptions = {},
): Promise<BlobDescriptor> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const profile = options.profile ?? "direct";
  const server = normaliseBlossomServer(serverInput, profile);
  const template = buildUploadAuthorisation(
    inspected.sha256,
    server,
    undefined,
    options.authorisationLifetimeSeconds,
    profile,
  );
  const deadline = requestDeadline(options, "upload");
  try {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    const authorisation = await abortable(signEventExactly(template, signer, pubkey), deadline.signal);
    if (deadline.signal.aborted) throw deadline.signal.reason;
    const response = await abortable(fetchImpl(`${server}/upload`, {
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
      signal: deadline.signal,
    }), deadline.signal);
    if (response.status !== 200 && response.status !== 201) {
      const reason = safeDiagnostic(response.headers.get("X-Reason") || response.statusText || `HTTP ${response.status}`);
      throw new Error(`Blossom upload failed: ${reason}`);
    }
    const text = await readTextCapped(response, 64 * 1024, deadline.signal);
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
  } catch (error) {
    throw deadline.explain(error);
  } finally {
    deadline.dispose();
  }
}

async function readTextCapped(response: Response, maximumBytes: number, signal: AbortSignal): Promise<string> {
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
      const { done, value } = await abortable(reader.read(), signal);
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
    if (signal.aborted) await reader.cancel(signal.reason).catch(() => undefined);
    if (error instanceof TypeError) throw new Error("Blossom descriptor is not valid UTF-8.");
    throw error;
  }
  return text;
}

export async function fetchVerifiedBlob(
  resolved: ResolvedHybridEvent,
  options: BlossomRequestOptions = {},
): Promise<Blob> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const profile = options.profile ?? "direct";
  const url = normaliseBlossomUrl(resolved.url, resolved.sha256, profile);
  const deadline = requestDeadline(options, "retrieval");
  try {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    const response = await abortable(fetchImpl(url, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      signal: deadline.signal,
    }), deadline.signal);
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
    try {
      while (true) {
        const { done, value } = await abortable(reader.read(), deadline.signal);
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > resolved.size) {
          await reader.cancel("response larger than signed size");
          throw new Error("Blossom returned more bytes than the signed event permits.");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (deadline.signal.aborted) await reader.cancel(deadline.signal.reason).catch(() => undefined);
      throw error;
    }
    if (received !== resolved.size) throw new Error("Blossom returned fewer bytes than the signed event declares.");
    const blob = new Blob(chunks as BlobPart[], { type: resolved.mimeType });
    if (await abortable(sha256Hex(blob, deadline.signal), deadline.signal) !== resolved.sha256) {
      throw new Error("Blossom bytes failed SHA-256 verification.");
    }
    return blob;
  } catch (error) {
    throw deadline.explain(error);
  } finally {
    deadline.dispose();
  }
}
