import { validateEvent, verifyEvent } from "nostr-tools";
import { resolveHybridEvent } from "./nostr.js";
import { MAX_RELAY_MESSAGE_BYTES, normaliseRelayUrl, safeDiagnostic } from "./security.js";
import type { NetworkProfile, RelayResult, ResolvedHybridEvent, SignedNostrEvent } from "./types.js";

const RELAY_TIMEOUT_MS = 10_000;
type WebSocketConstructor = new (url: string | URL) => WebSocket;

function parseRelayMessage(data: unknown): unknown[] | null {
  if (typeof data !== "string" || data.length > MAX_RELAY_MESSAGE_BYTES) return null;
  try {
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
): Promise<RelayResult> {
  const relay = normaliseRelayUrl(relayInput, profile);
  if (!validateEvent(event) || !verifyEvent(event)) throw new Error("Refusing to publish an invalid Nostr event.");
  return new Promise((resolve) => {
    const socket = new WebSocketImpl(relay);
    let settled = false;
    const finish = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSocket(socket);
      resolve({ relay, ok, message: safeDiagnostic(message) });
    };
    const timer = globalThis.setTimeout(() => finish(false, "Timed out waiting for relay acknowledgement."), RELAY_TIMEOUT_MS);
    socket.addEventListener("open", () => socket.send(JSON.stringify(["EVENT", event])));
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
): Promise<RelayResult[]> {
  return Promise.all(relays.map((relay) => publishToRelay(relay, event, profile)));
}

export function fetchFromRelay(
  relayInput: string,
  eventId: string,
  profile: NetworkProfile = "direct",
  WebSocketImpl: WebSocketConstructor = WebSocket,
  signal?: AbortSignal,
): Promise<ResolvedHybridEvent> {
  const relay = normaliseRelayUrl(relayInput, profile);
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
    socket.addEventListener("open", () => socket.send(JSON.stringify(["REQ", subscription, { ids: [eventId], kinds: [1063], limit: 1 }])));
    socket.addEventListener("message", ({ data }) => {
      const message = parseRelayMessage(data);
      if (message?.[0] === "EVENT" && message[1] === subscription && message[2] && typeof message[2] === "object") {
        try {
          const event = message[2] as SignedNostrEvent;
          if (event.id !== eventId) return;
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
): Promise<ResolvedHybridEvent> {
  if (relays.length === 0) throw new Error("Provide at least one relay.");
  const controller = new AbortController();
  try {
    return await Promise.any(relays.map((relay) => fetchFromRelay(relay, eventId, profile, WebSocket, controller.signal)));
  } catch (error) {
    if (error instanceof AggregateError) {
      throw new Error(error.errors.map(safeDiagnostic).join("\n"));
    }
    throw error;
  } finally {
    controller.abort();
  }
}
