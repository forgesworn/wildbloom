import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { buildUploadAuthorisation, encodeNostrAuthorisation, signEventExactly, validateBlobDescriptor } from "../core/nostr.js";
import type { BlobDescriptor, EventTemplate, SignedNostrEvent, SignerPort } from "../core/types.js";
import { WILDBLOOM_ENCRYPTED_MIME_TYPE } from "../core/types.js";
import type { RequestInvitation } from "./request.js";

/**
 * The upload half of a file request. The page signs ordinary BUD-11 `upload`
 * events with the request key from the invitation, asks the node whether it
 * will take the bytes (`HEAD /upload`), then sends them (`PUT /upload`).
 * A cut-off upload is repeated with a fresh event: the node keeps nothing that
 * fails its length and digest check, and repeating after a hidden success
 * answers 200 for the same bytes.
 */

/** What an attempt can end in, in the page's terms. */
export type UploadFailure =
  | "network" // no answer, or the connection broke: retry
  | "unavailable" // the node answered 5xx or asked to slow down: retry
  | "ended" // the grant has ended
  | "no-room" // the node cannot hold the file
  | "unauthorised" // the node did not accept the signed event, usually a wrong phone clock
  | "refused"; // anything else it said no to

export class UploadError extends Error {
  constructor(
    readonly failure: UploadFailure,
    readonly status?: number,
    readonly reason?: string,
  ) {
    super(`The upload failed: ${failure}${status === undefined ? "" : ` (${status})`}.`);
    this.name = "UploadError";
  }

  /** Worth repeating without asking anyone. */
  get retryable(): boolean {
    return this.failure === "network" || this.failure === "unavailable";
  }
}

/** The connection failed before any response was read. */
export class TransportNetworkError extends Error {
  constructor() {
    super("The connection failed.");
    this.name = "TransportNetworkError";
  }
}

export interface TransportResponse {
  readonly status: number;
  /** The `X-Reason` header, or empty. */
  readonly reason: string;
  /** The body, capped by the transport. */
  readonly body: string;
}

export interface TransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** The two requests, injected so tests need no browser. Reject with `TransportNetworkError` when no response arrives. */
export interface UploadTransport {
  head(request: TransportRequest): Promise<TransportResponse>;
  put(request: TransportRequest & { readonly body: Blob; readonly onProgress?: (sent: number, total: number) => void }): Promise<TransportResponse>;
}

/** A signer that holds the request key in the page, for the BUD-11 events only. */
export function localSigner(secretKey: Uint8Array): SignerPort {
  return {
    getPublicKey: () => Promise.resolve(getPublicKey(secretKey)),
    signEvent: (template: EventTemplate): Promise<SignedNostrEvent> => Promise.resolve(finalizeEvent({ ...template, tags: template.tags.map((tag) => [...tag]) }, secretKey)),
  };
}

/** Longest a BUD-11 event may live; the widest margin for a phone clock that runs slow. */
const AUTHORISATION_LIFETIME_SECONDS = 300;
const RESPONSE_CAP_CHARACTERS = 64 * 1024;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The node's own error code, from the header or a JSON body, whichever it sent. */
function reasonOf(response: TransportResponse): string {
  if (response.reason) return response.reason;
  try {
    const parsed = JSON.parse(response.body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error.slice(0, 64) : "";
  } catch {
    return "";
  }
}

/** Maps a refusal to what the page should say. A status below 300 is not an error. */
export function classifyResponse(response: TransportResponse): UploadFailure | undefined {
  const { status } = response;
  if (status >= 200 && status < 300) return undefined;
  const reason = reasonOf(response);
  if (reason === "request_ended") return "ended";
  if (status === 401) return "unauthorised";
  if (status === 413 || status === 507) return "no-room";
  if (status === 408 || status === 429 || status >= 500) return "unavailable";
  return "refused";
}

async function authorisation(invitation: Pick<RequestInvitation, "serverTag" | "node" | "signer" | "pubkey">, sha256: string, now: () => number): Promise<string> {
  const template = buildUploadAuthorisation(sha256, invitation.node, now(), AUTHORISATION_LIFETIME_SECONDS);
  const signed = await signEventExactly(template, localSigner(invitation.signer), invitation.pubkey);
  return encodeNostrAuthorisation(signed, now());
}

export interface UploadRequest {
  readonly invitation: Pick<RequestInvitation, "origin" | "node" | "serverTag" | "signer" | "pubkey" | "until">;
  /** The encrypted envelope. */
  readonly envelope: Blob;
  readonly sha256: string;
  readonly transport: UploadTransport;
  /** Unix seconds. */
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (sent: number, total: number) => void;
}

function check(response: TransportResponse): void {
  const failure = classifyResponse(response);
  if (failure) throw new UploadError(failure, response.status, reasonOf(response));
}

async function exchange<T>(call: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof UploadError) throw error;
    throw new UploadError("network");
  }
}

/**
 * One attempt: preflight, then upload, each with a fresh signed event. Resolves
 * with the node's validated descriptor, or throws an `UploadError`.
 */
export async function uploadEnvelope(request: UploadRequest): Promise<BlobDescriptor> {
  const { invitation, envelope, sha256, transport, signal } = request;
  const now = request.now ?? nowSeconds;
  if (now() >= invitation.until) throw new UploadError("ended");
  const common = { "X-SHA-256": sha256 } as const;
  const preflightAuthorisation = await authorisation(invitation, sha256, now);
  const preflight = await exchange(() => transport.head({
    url: `${invitation.origin}/upload`,
    headers: {
      ...common,
      "X-Content-Length": String(envelope.size),
      "X-Content-Type": WILDBLOOM_ENCRYPTED_MIME_TYPE,
      Authorization: preflightAuthorisation,
    },
    ...(signal ? { signal } : {}),
  }), signal);
  check(preflight);

  // A fresh event for the upload itself: the preflight may have taken a while on a slow connection.
  const uploadAuthorisation = await authorisation(invitation, sha256, now);
  const response = await exchange(() => transport.put({
    url: `${invitation.origin}/upload`,
    headers: {
      ...common,
      "Content-Type": WILDBLOOM_ENCRYPTED_MIME_TYPE,
      Authorization: uploadAuthorisation,
    },
    body: envelope,
    ...(signal ? { signal } : {}),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
  }), signal);
  check(response);

  // The node answered 2xx; its descriptor must describe exactly these bytes and sit on the same origin.
  let descriptor: BlobDescriptor;
  try {
    descriptor = validateBlobDescriptor(JSON.parse(response.body), { sha256, size: envelope.size });
    if (new URL(descriptor.url).origin !== invitation.origin) throw new Error("origin");
  } catch {
    throw new UploadError("refused", response.status, "descriptor");
  }
  return descriptor;
}

/** Waits 5 s, 15 s and 60 s between automatic attempts; after that the page asks the person to try again. */
export const RETRY_DELAYS_MS: readonly number[] = Object.freeze([5_000, 15_000, 60_000]);

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      finish();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface RetryOptions<T> {
  /** One attempt; throws `UploadError`. */
  readonly attempt: () => Promise<T>;
  /** When the grant ends, in Unix seconds: no attempt starts at or after it. */
  readonly until: number;
  readonly delays?: readonly number[];
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Called before each wait, with how many automatic attempts have failed so far. */
  readonly onWait?: (failed: number, delayMs: number, error: UploadError) => void;
}

/**
 * Repeats a retryable attempt on the schedule, then gives up with the last
 * error. A refusal is never repeated, and nothing starts once the grant ends.
 */
export async function withRetries<T>(options: RetryOptions<T>): Promise<T> {
  const delays = options.delays ?? RETRY_DELAYS_MS;
  const now = options.now ?? nowSeconds;
  const wait = options.wait ?? sleep;
  for (let failed = 0; ; failed += 1) {
    if (now() >= options.until) throw new UploadError("ended");
    try {
      return await options.attempt();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!(error instanceof UploadError) || !error.retryable || failed >= delays.length) throw error;
      const delay = delays[failed]!;
      options.onWait?.(failed + 1, delay, error);
      await wait(delay, options.signal);
    }
  }
}

/** Stalled for this long with no progress counts as a broken connection. The node itself allows 60 s between chunks. */
const STALL_MS = 90_000;
/** Once every byte is sent the node checks the length and digest before it answers, which takes longer on a big file. */
const ANSWER_MS = 5 * 60_000;

/** The real transport. `fetch` for the preflight, `XMLHttpRequest` for the upload because only it reports progress. */
export function createBrowserTransport(): UploadTransport {
  return {
    async head({ url, headers, signal }) {
      try {
        const response = await fetch(url, {
          method: "HEAD",
          headers,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "error",
          ...(signal ? { signal } : {}),
        });
        return { status: response.status, reason: response.headers.get("X-Reason") ?? "", body: "" };
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new TransportNetworkError();
      }
    },
    put({ url, headers, body, signal, onProgress }) {
      return new Promise<TransportResponse>((resolve, reject) => {
        const request = new XMLHttpRequest();
        let stall: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          clearTimeout(stall);
          signal?.removeEventListener("abort", abort);
        };
        const abort = (): void => {
          finish();
          request.abort();
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        const watch = (milliseconds = STALL_MS): void => {
          clearTimeout(stall);
          stall = setTimeout(() => {
            finish();
            request.abort();
            reject(new TransportNetworkError());
          }, milliseconds);
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        request.open("PUT", url);
        request.responseType = "text";
        for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
        request.upload.addEventListener("progress", (event) => {
          watch();
          if (event.lengthComputable) onProgress?.(event.loaded, event.total);
        });
        request.upload.addEventListener("load", () => watch(ANSWER_MS));
        request.addEventListener("load", () => {
          finish();
          resolve({
            status: request.status,
            reason: request.getResponseHeader("X-Reason") ?? "",
            body: request.responseText.slice(0, RESPONSE_CAP_CHARACTERS),
          });
        });
        const broken = (): void => {
          finish();
          reject(new TransportNetworkError());
        };
        request.addEventListener("error", broken);
        request.addEventListener("timeout", broken);
        request.addEventListener("abort", () => {
          if (!signal?.aborted) broken();
        });
        watch();
        request.send(body);
      });
    },
  };
}
