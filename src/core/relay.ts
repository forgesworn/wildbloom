import { validateEvent, verifyEvent } from "nostr-tools/pure";
import { resolveHybridEvent } from "./nostr.js";
import {
  assertHex64,
  MAX_NETWORK_ENDPOINTS,
  MAX_RELAY_MESSAGE_BYTES,
  normaliseRelayUrl,
  safeDiagnostic,
} from "./security.js";
import type { NetworkProfile, RelayResult, ResolvedHybridEvent, SignedNostrEvent } from "./types.js";

const RELAY_TIMEOUT_MS = 10_000;
type WebSocketConstructor = new (url: string | URL) => WebSocket;

function parseRelayMessage(data: unknown): unknown[] | null {
  if (typeof data !== "string" || data.length > MAX_RELAY_MESSAGE_BYTES) return null;
  try {
    if (new TextEncoder().encode(data).byteLength > MAX_RELAY_MESSAGE_BYTES) return null;
    const parsed: unknown = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === 0 || socket.readyState === 1) socket.close();
}

export function publishToRelay(
  relayInput: string,
  event: SignedNostrEvent,
  profile: NetworkProfile = "direct",
  WebSocketImpl: WebSocketConstructor = WebSocket,
  signal?: AbortSignal,
): Promise<RelayResult> {
  const relay = normaliseRelayUrl(relayInput, profile);
  if (!validateEvent(event) || !verifyEvent(event)) throw new Error("Refusing to publish an invalid Nostr event.");
  if (signal?.aborted) {
    return Promise.resolve({ relay, ok: false, message: "Relay publication cancelled before connection." });
  }
  return new Promise((resolve) => {
    const socket = new WebSocketImpl(relay);
    let settled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      closeSocket(socket);
      resolve({ relay, ok, message: safeDiagnostic(message) });
    };
    const abort = (): void => finish(false, "Relay publication cancelled. An event already sent cannot be retracted.");
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    timer = globalThis.setTimeout(() => finish(false, "Timed out waiting for relay acknowledgement."), RELAY_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      if (!settled && !signal?.aborted) socket.send(JSON.stringify(["EVENT", event]));
    });
    socket.addEventListener("message", ({ data }) => {
      const message = parseRelayMessage(data);
      if (message?.[0] === "OK" && message[1] === event.id && typeof message[2] === "boolean") {
        finish(message[2], String(message[3] ?? (message[2] ? "accepted" : "rejected")));
      }
    });
    socket.addEventListener("error", () => finish(false, "Relay connection failed."));
    socket.addEventListener("close", () => finish(false, "Relay closed before acknowledging the event."));
  });
}

export async function publishToRelays(
  relays: readonly string[],
  event: SignedNostrEvent,
  profile: NetworkProfile = "direct",
  signal?: AbortSignal,
): Promise<RelayResult[]> {
  if (relays.length === 0) throw new Error("Provide at least one relay.");
  if (relays.length > MAX_NETWORK_ENDPOINTS) throw new Error(`At most ${MAX_NETWORK_ENDPOINTS} relays may be used at once.`);
  const targets = [...new Set(relays.map((relay) => normaliseRelayUrl(relay, profile)))];
  return Promise.all(targets.map((relay) => publishToRelay(relay, event, profile, WebSocket, signal)));
}

export function fetchFromRelay(
  relayInput: string,
  eventId: string,
  profile: NetworkProfile = "direct",
  WebSocketImpl: WebSocketConstructor = WebSocket,
  signal?: AbortSignal,
): Promise<ResolvedHybridEvent> {
  const relay = normaliseRelayUrl(relayInput, profile);
  const exactEventId = assertHex64(eventId, "Event ID");
  if (signal?.aborted) return Promise.reject(new Error(`${relay}: lookup cancelled before connection.`));
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(relay);
    const subscription = `wildbloom-${crypto.randomUUID()}`;
    let settled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (result: ResolvedHybridEvent | Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(["CLOSE", subscription]));
      closeSocket(socket);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const abort = (): void => finish(new Error(`${relay}: lookup cancelled.`));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    timer = globalThis.setTimeout(() => finish(new Error(`${relay}: lookup timed out.`)), RELAY_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      if (!settled && !signal?.aborted) {
        socket.send(JSON.stringify(["REQ", subscription, { ids: [exactEventId], kinds: [1063], limit: 1 }]));
      }
    });
    socket.addEventListener("message", ({ data }) => {
      const message = parseRelayMessage(data);
      if (message?.[0] === "EVENT" && message[1] === subscription && message[2] && typeof message[2] === "object") {
        try {
          const event = message[2] as SignedNostrEvent;
          if (event.id !== exactEventId) return;
          finish(resolveHybridEvent(event, profile));
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Relay returned an invalid event."));
        }
      }
      if (message?.[0] === "EOSE" && message[1] === subscription) finish(new Error(`${relay}: event not found.`));
    });
    socket.addEventListener("error", () => finish(new Error(`${relay}: connection failed.`)));
    socket.addEventListener("close", () => finish(new Error(`${relay}: connection closed.`)));
  });
}

export async function resolveFromRelays(
  relays: readonly string[],
  eventId: string,
  profile: NetworkProfile = "direct",
  signal?: AbortSignal,
): Promise<ResolvedHybridEvent> {
  if (relays.length === 0) throw new Error("Provide at least one relay.");
  if (relays.length > MAX_NETWORK_ENDPOINTS) throw new Error(`At most ${MAX_NETWORK_ENDPOINTS} relays may be used at once.`);
  const exactEventId = assertHex64(eventId, "Event ID");
  const targets = [...new Set(relays.map((relay) => normaliseRelayUrl(relay, profile)))];
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.any(targets.map((relay) => fetchFromRelay(relay, exactEventId, profile, WebSocket, controller.signal)));
  } catch (error) {
    if (error instanceof AggregateError) {
      throw new Error(error.errors.map(safeDiagnostic).join("\n"));
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
