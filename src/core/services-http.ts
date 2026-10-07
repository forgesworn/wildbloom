import { sha256Hex } from "./crypto.js";
import { signEventExactly } from "./nostr.js";
import { assertHex64, normaliseBlossomServer } from "./security.js";
import type { EventTemplate, NetworkProfile, SignerPort } from "./types.js";

export type ServicePhase = "signing" | "request";
export type ServiceFailureCode = "signer" | "expired" | "cancelled" | "http" | "response" | "network";
export class ServiceRequestError extends Error {
  constructor(readonly code: ServiceFailureCode, message: string, readonly status?: number) {
    super(message);
    this.name = "ServiceRequestError";
  }
}

export interface ServiceOptions {
  onPhase?: (phase: ServicePhase) => void;
  profile?: NetworkProfile;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
export interface Buyer {
  signer: SignerPort;
  pubkey: string;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid service response.");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)
  )
    throw new Error("Invalid service text.");
  return value;
}
export function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new Error("Invalid service amount or time.");
  return value;
}
export async function httpTemplate(
  url: string,
  method: "GET" | "POST",
  body: string,
): Promise<EventTemplate> {
  const tags = [
    ["u", url],
    ["method", method],
  ];
  if (method === "POST")
    tags.push(["payload", await sha256Hex(new Blob([body]))]);
  return {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags,
  };
}

export async function requestJson(
  origin: string,
  path: string,
  body: unknown | undefined,
  buyer: Buyer | undefined,
  options: ServiceOptions = {},
): Promise<unknown> {
  const base = normaliseBlossomServer(origin, options.profile ?? "direct");
  if (
    !/^\/(?:checkout\/v1\/(?:offers|orders(?:\/[a-zA-Z0-9_-]{1,128}(?:\/(?:lightning|lnurlcash|check))?)?)|storage\/v1\/proof)$/u.test(
      path,
    )
  )
    throw new Error("Unsupported service path.");
  const url = base + path;
  const encoded = body === undefined ? "" : JSON.stringify(body);
  if (new TextEncoder().encode(encoded).length > 16384)
    throw new Error("Service request is too large.");
  const timeout = options.timeoutMs ?? 45_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
    throw new Error("Invalid service timeout.");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, timeout);
  const audit = path === "/storage/v1/proof";
  let phase: ServicePhase = "request";
  try {
    controller.signal.throwIfAborted();
    const method = body === undefined ? "GET" : "POST";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (buyer) {
      phase = "signing";
      options.onPhase?.(phase);
      const template = await httpTemplate(url, method, encoded);
      const event = await signEventExactly(
        template,
        buyer.signer,
        assertHex64(buyer.pubkey, "Buyer public key"),
      );
      controller.signal.throwIfAborted();
      if (Math.floor(Date.now() / 1000) > template.created_at + 55)
        throw new ServiceRequestError("expired", "Signature expired; repeat this action and approve promptly.");
      headers.Authorization = `Nostr ${btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(event))))}`;
    }
    controller.signal.throwIfAborted();
    phase = "request";
    options.onPhase?.(phase);
    const response = await (options.fetchImpl ?? fetch)(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: encoded }),
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (
      !response.ok ||
      !response.body ||
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      await response.body?.cancel();
      throw new ServiceRequestError(
        "http",
        audit
          ? `Service request failed (HTTP ${response.status}); the storage audit was not verified.`
          : `Service request failed (${response.status}); no payment outcome can be inferred.`,
        response.status,
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 65536) throw new ServiceRequestError("response", "Service response is too large.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    controller.signal.throwIfAborted();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw new ServiceRequestError("response", "Invalid service JSON response.");
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new ServiceRequestError(
        "cancelled",
        audit
          ? "Storage audit cancelled or timed out; retry when the signer and node are ready."
          : "Service action cancelled or timed out. A pending payment may still need reconciliation.",
      );
    // Only our own typed failures are safe to display. Signers and fetch may
    // include URLs, tokens or arbitrary remote content in their exceptions.
    if (error instanceof ServiceRequestError) throw error;
    if (phase === "signing")
      throw new ServiceRequestError(
        "signer", "Signer approval failed or the returned signature was invalid. Check your signer and retry.",
      );
    throw new ServiceRequestError(
      "network",
      audit
        ? "Storage audit request failed; check node connectivity and browser access."
        : "Service action failed; check the same order before attempting another payment.",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
