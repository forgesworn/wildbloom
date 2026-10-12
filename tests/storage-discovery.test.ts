import { readFileSync } from "node:fs";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStorageAnnouncement, buildStorageAnnouncement } from "402-announce/storage";
import type { StorageServiceDescription } from "402-announce";
import { StorageDirectory, fetchServiceDescription, matchDiscoveredOffers, selectableService, serviceOrigins } from "../src/core/storage-discovery.js";
import { requestJson } from "../src/core/services-http.js";
import type { Offers } from "../src/core/checkout.js";

const now = 1800000300;
const secret = new Uint8Array(32).fill(1);
const key = getPublicKey(secret);
function fixture(name: string): { signed_event: unknown; description: StorageServiceDescription } {
  return JSON.parse(readFileSync(`node_modules/402-announce/fixtures/storage-v1/${name}.json`, "utf8"));
}
function signed(description: StorageServiceDescription): ReturnType<typeof finalizeEvent> {
  return finalizeEvent(buildStorageAnnouncement(description), secret);
}
function socketFor(events: unknown[], mode = "ok"): typeof WebSocket {
  return class extends EventTarget {
    readyState = 0;
    constructor(_url: string) {
      super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
    }
    send(data: string): void {
      const request = JSON.parse(data);
      if (request[0] !== "REQ") return;
      expect(request[2]).toEqual({ kinds: [31402], "#t": ["forgesworn-storage-service-v1"], limit: 64 });
      const emit = (value: unknown): void => { this.dispatchEvent(new MessageEvent("message", { data: value })); };
      if (mode === "silent") return;
      if (mode === "error" || mode === "close") { this.dispatchEvent(new Event(mode)); return; }
      if (mode === "oversized") { emit("x".repeat(66_561)); return; }
      if (mode === "binary") { emit(new Uint8Array(1)); return; }
      if (mode === "flood") { for (let i = 0; i < 130; i++) emit("invalid"); return; }
      if (mode === "closed") { emit(JSON.stringify(["CLOSED", request[1], "refused"])); return; }
      emit("bad JSON"); emit(JSON.stringify({bad:"shape"})); emit(JSON.stringify(["EOSE","wrong"]));
      emit(JSON.stringify(["NOTICE",request[1],"notice"]));
      for (const e of events) emit(JSON.stringify(["EVENT",request[1],e]));
      emit(JSON.stringify(["EOSE",request[1]]));
      emit(JSON.stringify(["EVENT",request[1],events[0]]));
    }
    close(): void { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  } as unknown as typeof WebSocket;
}
function offers(description: StorageServiceDescription): Offers {
  const c = description.checkout!;
  return {version:1,seller_id:"operator",seller_name:"Synthetic operator",node_origin:c.origin,network:c.network,
    offers: description.services.filter(s => s.type === "paid-storage").map(s => { const {type:_type,availability:_availability,...offer} = s; return offer; }),
    rails:c.rails,issuers:c.issuers,features:[]};
}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now*1000));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("explicit public storage discovery", () => {
  it("uses the shared signed fixtures and contacts only explicitly configured relays", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const raw = [fixture("paid").signed_event, fixture("free").signed_event, fixture("combined").signed_event];
    // Equal timestamp tie follows event ID, never delivery order.
    const d = new StorageDirectory();
    const results = await d.discover(["wss://relay.example/"],{now,WebSocketImpl:socketFor(raw)});
    expect(results).toHaveLength(1);
    const ids = raw.map(e => (e as {id:string}).id).sort(); expect(results[0]!.event.id).toBe(ids[0]);
    expect(fetch).not.toHaveBeenCalled();
    expect(results[0]!.description.service_pubkey).toBe(key);
  });
  it.each(["expired","withdrawn","full"])("remembers the latest %s watermark across lookups and never revives an older offer", async name => {
    const d = new StorageDirectory();
    await d.discover(["wss://relay.example/"],{now,WebSocketImpl:socketFor([fixture("paid").signed_event,fixture(name).signed_event])});
    const later = await d.discover(["wss://relay.example/"],{now,WebSocketImpl:socketFor([fixture("paid").signed_event])});
    expect(later[0]!.event.id).toBe((fixture(name).signed_event as {id:string}).id);
    expect(selectableService(later[0]!,now)).toBe(false);
  });
  it("filters origins after replacement and reevaluates expiration without background networking", () => {
    const d = new StorageDirectory();
    const paid = d.accept([fixture("paid").signed_event],now)[0]!;
    expect(serviceOrigins(paid,"direct")).toEqual(["https://storage.example/"]);
    expect(serviceOrigins(paid,"tor")).toEqual([]);
    const free = parseStorageAnnouncement(fixture("free-onion").signed_event,{now});
    expect(serviceOrigins(free,"tor")).toHaveLength(1); expect(serviceOrigins(free,"direct")).toEqual([]);
    expect(selectableService(paid,paid.description.expires_at)).toBe(false);
    expect(d.current(paid.description.expires_at)[0]!.freshness).toBe("expired");
  });
  it("ignores every cryptographically valid hostile contract fixture", async () => {
    const manifest = JSON.parse(readFileSync("node_modules/402-announce/fixtures/storage-v1/manifest.json","utf8"));
    const rejected = manifest.cases.filter((name:string) => name.startsWith("reject-")).map((name:string) => fixture(name.slice(0,-5)).signed_event);
    const d = new StorageDirectory();
    expect(await d.discover(["wss://relay.example/"],{now,WebSocketImpl:socketFor(rejected)})).toEqual([]);
  });
  it.each(["error","close","closed","binary","oversized","flood"])("refuses bounded relay failure: %s", async mode => {
    await expect(new StorageDirectory().discover(["wss://relay.example/"],{now,WebSocketImpl:socketFor([],mode)})).rejects.toThrow(/No relay/u);
  });
  it("allows one failed relay, validates bounds, cancels and times out", async () => {
    const Good = socketFor([fixture("paid").signed_event]), Bad = socketFor([],"error");
    class Multi { constructor(url:string) { return new (url.includes("bad") ? Bad : Good)(url); } }
    vi.stubGlobal("WebSocket",Multi);
    expect(await new StorageDirectory().discover(["wss://bad.example/","wss://good.example/"],{now})).toHaveLength(1);
    for (const relays of [[],Array(9).fill("wss://relay.example/"),["ws://relay.example/"]])
      await expect(new StorageDirectory().discover(relays,{now})).rejects.toThrow();
    await expect(new StorageDirectory().discover(["wss://relay.example/"],{now,timeoutMs:30001})).rejects.toThrow();
    const controller = new AbortController();
    const pending = new StorageDirectory().discover(["wss://relay.example/"],{now,signal:controller.signal,WebSocketImpl:socketFor([],"silent")});
    controller.abort(); await expect(pending).rejects.toThrow();
    await expect(new StorageDirectory().discover(["wss://relay.example/"],{now,signal:controller.signal,WebSocketImpl:Good})).rejects.toThrow();
    vi.useFakeTimers();
    const timeout = expect(new StorageDirectory().discover(["wss://relay.example/"],{now,timeoutMs:10,WebSocketImpl:socketFor([],"silent")})).rejects.toThrow(/No relay/u);
    await vi.advanceTimersByTimeAsync(11); await timeout;
  });
  it("caps record and memory growth without discarding replacement watermarks", async () => {
    const paid = fixture("paid").signed_event;
    await expect(new StorageDirectory().discover(["wss://relay.example/"],{now,WebSocketImpl:socketFor(Array(65).fill(paid))})).rejects.toThrow();
    const base = fixture("free").description;
    const d = new StorageDirectory();
    d.accept(Array.from({length:512},(_,i) => signed({...base,identifier:`service-${i}`})),now);
    expect(() => d.accept([signed({...base,identifier:"extra"})],now)).toThrow(/memory limit/u);
    expect(d.current(now)).toHaveLength(512);
  });
  it("fetches only the selected origin with a bounded unsigned GET and binds the HTTP identity", async () => {
    const f = fixture("paid"), a = parseStorageAnnouncement(f.signed_event,{now});
    const fresh = {...f.description,observed_at:now,expires_at:now+7200};
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(fresh),{headers:{"content-type":"application/json"}}));
    const result = await fetchServiceDescription(a,"https://storage.example/",{fetchImpl:fetch});
    expect(result.service_pubkey).toBe(key);
    expect(fetch).toHaveBeenCalledWith("https://storage.example/services/v1",expect.objectContaining({method:"GET",credentials:"omit",redirect:"error",cache:"no-store",referrerPolicy:"no-referrer"}));
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty("body");
    expect((fetch.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty("Authorization");
    await expect(fetchServiceDescription(a,"https://other.example/",{fetchImpl:fetch})).rejects.toThrow();
    await expect(fetchServiceDescription(a,"https://storage.example/",{profile:"tor",fetchImpl:fetch})).rejects.toThrow();
    await expect(fetchServiceDescription(a,"https://storage.example/",{fetchImpl:async () => new Response(JSON.stringify({...fresh,service_pubkey:"0".repeat(64)}),{headers:{"content-type":"application/json"}})})).rejects.toThrow();
    vi.spyOn(Date,"now").mockReturnValue(a.description.expires_at*1000);
    await expect(fetchServiceDescription(a,"https://storage.example/",{fetchImpl:fetch})).rejects.toThrow(/expired/u);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses signed or mutating service inspections and response failures without payment language", async () => {
    const a = parseStorageAnnouncement(fixture("paid").signed_event,{now});
    await expect(requestJson("https://storage.example/","/services/v1",{},undefined)).rejects.toThrow(/unsigned GET/u);
    await expect(requestJson("https://storage.example/","/services/v1",undefined,{} as never)).rejects.toThrow(/unsigned GET/u);
    await expect(fetchServiceDescription(a,"https://storage.example/",{fetchImpl:async () => new Response("denied",{status:403})})).rejects.toThrow(/Service description request failed/u);
    await expect(fetchServiceDescription(a,"https://storage.example/",{fetchImpl:async () => {throw Error("private URL")}})).rejects.toThrow(/connectivity/u);
    const c = new AbortController(); c.abort();
    await expect(fetchServiceDescription(a,"https://storage.example/",{signal:c.signal})).rejects.toThrow(/inspection cancelled/u);
  });
  it("uses current HTTP terms and rejects changed offers, issuers, rails and withdrawal before quoting", () => {
    const d = fixture("paid").description, o = offers(d);
    expect(matchDiscoveredOffers(d,o,now)).toEqual(o);
    for (const changed of [
      {...o,offers:o.offers.map(offer => ({...offer,price_msat:offer.price_msat+1000}))},
      {...o,node_origin:"https://other.example/"}, {...o,network:"regtest" as const}, {...o,rails:[]},
      {...o,issuers:o.issuers.map(i => ({...i,callback:"https://other.example/callback"}))},
    ]) expect(() => matchDiscoveredOffers(d,changed,now)).toThrow(/changed/u);
    expect(() => matchDiscoveredOffers({...d,state:"withdrawn"},o,now)).toThrow();
    expect(() => matchDiscoveredOffers(d,o,d.expires_at)).toThrow();
    const unavailable = {...d,services:d.services.map(s => ({...s,availability:"full" as const}))};
    expect(() => matchDiscoveredOffers(unavailable,o,now)).toThrow(/no accepting/u);
    const extra = {...d,services:[...d.services,...d.services.map(s => ({...s,id:"another",availability:"full" as const}))]};
    expect(matchDiscoveredOffers(extra,offers(extra),now).offers).toHaveLength(1);
    const lightning = {...d,checkout:{...d.checkout!,rails:["lightning" as const],issuers:[]}};
    expect(matchDiscoveredOffers(lightning,{...o,rails:["lightning"]},now).issuers).toEqual(o.issuers);
  });
});
