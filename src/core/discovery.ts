import { validateEvent, verifyEvent } from "nostr-tools/pure";
import {
  assertHex64,
  MAX_NETWORK_ENDPOINTS,
  normaliseBlossomServer,
  normaliseRelayUrl,
} from "./security.js";
import type {
  EventTemplate,
  NetworkProfile,
  SignedNostrEvent,
} from "./types.js";

export interface DiscoveredNode {
  origin: string;
  recommendedBy: string[];
  updatedAt: number;
}
export interface DiscoveryOptions {
  profile?: NetworkProfile;
  signal?: AbortSignal;
  WebSocketImpl?: typeof WebSocket;
  timeoutMs?: number;
  now?: number;
}

export function serverList(
  template: unknown,
  trusted: readonly string[],
  profile: NetworkProfile,
  now: number,
): { event: SignedNostrEvent; origins: string[] } {
  const event = template as SignedNostrEvent;
  if (
    !event ||
    JSON.stringify(event).length > 16384 ||
    !validateEvent(event) ||
    !verifyEvent(event) ||
    event.kind !== 10063 ||
    !trusted.includes(event.pubkey) ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at > now + 30 ||
    event.created_at < now - 30 * 86400 ||
    event.tags.length > 64
  )
    throw new Error("Invalid, stale or untrusted server list.");
  const tags = event.tags.filter((t) => t[0] === "server");
  if (!tags.length || tags.length > 16 || tags.some((t) => t.length !== 2))
    throw new Error("Invalid server list entries.");
  const origins: string[] = [];
  for (const tag of tags) {
    try {
      origins.push(`${normaliseBlossomServer(tag[1]!, profile)}/`);
    } catch {
      /* Mixed-profile lists may contain endpoints we must never contact. */
    }
  }
  return { event, origins: [...new Set(origins)] };
}

export function buildServerList(
  origins: string[],
  profile: NetworkProfile,
): EventTemplate {
  if (!origins.length || origins.length > 16)
    throw new Error("Choose 1–16 servers for the public list.");
  return {
    kind: 10063,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ...new Set(origins.map((u) => `${normaliseBlossomServer(u, profile)}/`)),
    ].map((u) => ["server", u]),
  };
}

function query(
  relay: string,
  authors: string[],
  options: DiscoveryOptions,
): Promise<SignedNostrEvent[]> {
  const profile = options.profile ?? "direct";
  const now = options.now ?? Math.floor(Date.now() / 1000);
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new (options.WebSocketImpl ?? WebSocket)(relay);
    const subscription = `wildbloom-discovery-${crypto.randomUUID()}`;
    const events: SignedNostrEvent[] = [];
    let messages = 0;
    let ended = false;
    const finish = (error?: Error): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (socket.readyState === 1)
        socket.send(JSON.stringify(["CLOSE", subscription]));
      if (socket.readyState < 2) socket.close();
      if (error) reject(error);
      else resolve(events);
    };
    const abort = (): void => finish(new Error("Node discovery cancelled."));
    const timer = setTimeout(
      () => finish(new Error("Node discovery timed out.")),
      options.timeoutMs ?? 10000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    socket.addEventListener("open", () => {
      if (!ended)
        socket.send(
          JSON.stringify([
            "REQ",
            subscription,
            {
              kinds: [10063],
              authors,
              since: now - 30 * 86400,
              limit: authors.length,
            },
          ]),
        );
    });
    socket.addEventListener("message", ({ data }) => {
      if (ended) return;
      if (
        ++messages > 256 ||
        typeof data !== "string" ||
        new TextEncoder().encode(data).length > 32768
      ) {
        finish(new Error("Node discovery response exceeded its limit."));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (!Array.isArray(message) || message[1] !== subscription) return;
      if (message[0] === "EOSE") {
        finish();
        return;
      }
      if (message[0] !== "EVENT") return;
      try {
        events.push(serverList(message[2], authors, profile, now).event);
      } catch {
        /* A relay's invalid event never becomes a trusted result. */
      }
    });
    socket.addEventListener("error", () =>
      finish(new Error("Node discovery relay failed.")),
    );
    socket.addEventListener("close", () =>
      finish(new Error("Node discovery relay closed.")),
    );
  });
}

export async function discoverNodes(
  relays: readonly string[],
  trustedKeys: readonly string[],
  options: DiscoveryOptions = {},
): Promise<DiscoveredNode[]> {
  const profile = options.profile ?? "direct";
  if (
    !relays.length ||
    relays.length > MAX_NETWORK_ENDPOINTS ||
    !trustedKeys.length ||
    trustedKeys.length > 16
  )
    throw new Error("Provide bounded relay and trusted-key lists.");
  const authors = [
    ...new Set(trustedKeys.map((k) => assertHex64(k, "Trusted public key"))),
  ];
  const targets = [
    ...new Set(relays.map((r) => normaliseRelayUrl(r, profile))),
  ];
  const results = await Promise.allSettled(
    targets.map((r) => query(r, authors, options)),
  );
  options.signal?.throwIfAborted();
  if (results.every((r) => r.status === "rejected"))
    throw new Error("No relay completed node discovery.");
  const latest = new Map<string, SignedNostrEvent>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const event of result.value) {
      const previous = latest.get(event.pubkey);
      if (
        !previous ||
        event.created_at > previous.created_at ||
        (event.created_at === previous.created_at && event.id < previous.id)
      )
        latest.set(event.pubkey, event);
    }
  }
  const nodes = new Map<string, DiscoveredNode>();
  for (const author of authors) {
    const event = latest.get(author);
    if (!event) continue;
    for (const origin of serverList(
      event,
      authors,
      profile,
      options.now ?? Math.floor(Date.now() / 1000),
    ).origins) {
      const existing = nodes.get(origin);
      if (existing) {
        existing.recommendedBy.push(author);
        existing.updatedAt = Math.max(existing.updatedAt, event.created_at);
      } else
        nodes.set(origin, {
          origin,
          recommendedBy: [author],
          updatedAt: event.created_at,
        });
    }
  }
  return [...nodes.values()];
}
