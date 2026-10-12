import {
  parseStorageAnnouncement,
  selectStorageAnnouncements,
  validateStorageEndpointBinding,
  type ParsedStorageAnnouncement,
} from "402-announce/storage";
import type { StorageServiceDescription } from "402-announce";
import { normaliseBlossomServer, normaliseRelayUrl, MAX_NETWORK_ENDPOINTS } from "./security.js";
import { requestJson, type ServiceOptions } from "./services-http.js";
import type { DiscoveryOptions } from "./discovery.js";
import type { NetworkProfile } from "./types.js";
import type { Offer, Offers } from "./checkout.js";

// Single-letter topic tags are relay-indexable; PMI is deliberately not a filter.
const TOPIC = "forgesworn-storage-service-v1";
const MAX_RECORDS = 512;
const clock = (options: DiscoveryOptions): number => options.now ?? Math.floor(Date.now() / 1000);

function query(relay: string, options: DiscoveryOptions): Promise<unknown[]> {
  options.signal?.throwIfAborted();
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000)
    throw new Error("Invalid storage discovery timeout.");
  return new Promise((resolve, reject) => {
    const socket = new (options.WebSocketImpl ?? WebSocket)(relay);
    const subscription = `wildbloom-storage-${crypto.randomUUID()}`;
    const events: unknown[] = [];
    let messages = 0, ended = false;
    const finish = (error?: Error): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      try {
        if (socket.readyState === 1) socket.send(JSON.stringify(["CLOSE", subscription]));
        if (socket.readyState < 2) socket.close();
      } catch { /* An unavailable relay cannot keep the local query alive. */ }
      if (error) reject(error); else resolve(events);
    };
    const abort = (): void => finish(new Error("Storage service discovery cancelled."));
    const timer = setTimeout(() => finish(new Error("Storage service discovery timed out.")), timeout);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    socket.addEventListener("open", () => {
      if (ended) return;
      try {
        // Do not filter expired records at the relay or resurrect older offers.
        socket.send(JSON.stringify(["REQ", subscription, { kinds: [31402], "#t": [TOPIC], limit: 64 }]));
      } catch { finish(new Error("Storage discovery relay failed.")); }
    });
    socket.addEventListener("message", ({ data }) => {
      if (ended) return;
      if (++messages > 128 || typeof data !== "string" || new TextEncoder().encode(data).length > 66_560) {
        finish(new Error("Storage discovery exceeded its response limit.")); return;
      }
      let value: unknown;
      try { value = JSON.parse(data); } catch { return; }
      if (!Array.isArray(value) || value[1] !== subscription) return;
      if (value[0] === "EOSE") { finish(); return; }
      if (value[0] === "CLOSED") { finish(new Error("Storage discovery subscription was refused.")); return; }
      if (value[0] !== "EVENT") return;
      try {
        // Includes cryptographically valid expired/withdrawn records as watermarks.
        const parsed = parseStorageAnnouncement(value[2], { now: clock(options) });
        if (events.length >= 64) { finish(new Error("Storage discovery returned too many records.")); return; }
        events.push(parsed.event);
      } catch { /* Untrusted invalid content never becomes a listing or watermark. */ }
    });
    socket.addEventListener("error", () => finish(new Error("Storage discovery relay failed.")));
    socket.addEventListener("close", () => finish(new Error("Storage discovery relay closed.")));
  });
}

/** Page-memory signed watermarks. No persistence, endpoints, signer or wallet access. */
export class StorageDirectory {
  private watermarks = new Map<string, ParsedStorageAnnouncement>();

  accept(values: readonly unknown[], now: number): ParsedStorageAnnouncement[] {
    const incoming = selectStorageAnnouncements(values, { now });
    const merged = new Map(this.watermarks);
    for (const item of incoming) {
      const key = `${item.event.pubkey}:${item.description.identifier}`;
      const prior = merged.get(key)?.event;
      if (!prior || item.event.created_at > prior.created_at || (item.event.created_at === prior.created_at && item.event.id < prior.id))
        merged.set(key, item);
    }
    if (merged.size > MAX_RECORDS) throw new Error("Storage discovery reached its page-memory limit; start a new page session to search again.");
    this.watermarks = merged;
    return this.current(now);
  }
  current(now = Math.floor(Date.now() / 1000)): ParsedStorageAnnouncement[] {
    return selectStorageAnnouncements([...this.watermarks.values()].map(value => value.event), { now });
  }
  async discover(relays: readonly string[], options: DiscoveryOptions = {}): Promise<ParsedStorageAnnouncement[]> {
    if (!relays.length || relays.length > MAX_NETWORK_ENDPOINTS)
      throw new Error("Provide a bounded explicit relay list.");
    const targets = [...new Set(relays.map(relay => normaliseRelayUrl(relay, options.profile ?? "direct")))];
    const results = await Promise.allSettled(targets.map(relay => query(relay, options)));
    options.signal?.throwIfAborted();
    if (results.every(result => result.status === "rejected")) throw new Error("No relay completed storage service discovery.");
    return this.accept(results.flatMap(result => result.status === "fulfilled" ? result.value : []), clock(options));
  }
}

/** Filter transport only after selecting the latest signed record. Never contacts an origin. */
export function serviceOrigins(announcement: ParsedStorageAnnouncement, profile: NetworkProfile): string[] {
  return announcement.description.origins.filter(origin => {
    try { return `${normaliseBlossomServer(origin, profile)}/` === origin; } catch { return false; }
  });
}
export function selectableService(announcement: ParsedStorageAnnouncement, now = Math.floor(Date.now() / 1000)): boolean {
  const current = parseStorageAnnouncement(announcement.event, { now });
  return current.freshness === "current" && current.description.state === "published"
    && current.description.services.some(service => service.availability === "accepting");
}

/** Explicit user-triggered HTTP inspection. Validates identity and current terms without signing. */
export async function fetchServiceDescription(announcement: ParsedStorageAnnouncement, selectedOrigin: string,
  options: ServiceOptions = {}): Promise<StorageServiceDescription> {
  const profile = options.profile ?? "direct";
  if (!selectableService(announcement) || !serviceOrigins(announcement, profile).includes(selectedOrigin))
    throw new Error("This storage listing expired, was withdrawn or is unavailable for the selected network profile. Find services again.");
  const value = await requestJson(selectedOrigin, "/services/v1", undefined, undefined, { ...options, timeoutMs: options.timeoutMs ?? 15_000 });
  return validateStorageEndpointBinding(value, announcement, selectedOrigin, { now: Math.floor(Date.now() / 1000) });
}

/** Current signed-discovery HTTP terms must agree with the separately loaded checkout offers. */
export function matchDiscoveredOffers(description: StorageServiceDescription, offers: Offers,
  now = Math.floor(Date.now() / 1000)): Offers {
  const checkout = description.checkout;
  const paid = description.services.filter(service => service.type === "paid-storage");
  const unchanged = checkout && description.state === "published" && description.expires_at > now
    && checkout.origin === offers.node_origin && checkout.network === offers.network
    && checkout.rails.length === offers.rails.length && checkout.rails.every(rail => offers.rails.includes(rail))
    && offers.offers.length === paid.length && offers.offers.every(offer => paid.some(service =>
      Object.keys(offer).every(key => offer[key as keyof Offer] === service[key as keyof typeof service])))
    && (!checkout.rails.includes("lnurlcash") || (checkout.issuers.length === offers.issuers.length
      && checkout.issuers.every(issuer => offers.issuers.some(candidate =>
        candidate.id === issuer.id && candidate.callback === issuer.callback && candidate.note_endpoint === issuer.note_endpoint && candidate.mint_pubkey === issuer.mint_pubkey))));
  if (!unchanged) throw new Error("The operator’s checkout offers or terms changed, expired or were withdrawn. Load current service terms and review them again.");
  const accepting = offers.offers.filter(offer => paid.some(service => service.id === offer.id && service.availability === "accepting"));
  if (!accepting.length) throw new Error("This operator currently has no accepting paid storage offers.");
  return { ...offers, offers: accepting };
}
