import { finalizeEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFromRelay, publishToRelay, publishToRelays, resolveFromRelays } from "../src/core/relay.js";
import type { SignedNostrEvent } from "../src/core/types.js";

const secret = new Uint8Array(32).fill(23);
const sha256 = "ab".repeat(32);
const infoHash = "cd".repeat(20);

function fileEvent(): SignedNostrEvent {
  return finalizeEvent({
    kind: 1063,
    created_at: 2_000,
    tags: [
      ["url", `https://cdn.example.com/${sha256}.txt`],
      ["m", "text/plain"],
      ["x", sha256],
      ["ox", sha256],
      ["size", "5"],
      ["magnet", `magnet:?xt=urn%3Abtih%3A${infoHash}&dn=hello.txt&xl=5&tr=wss%3A%2F%2Ftracker.example.com%2F&ws=https%3A%2F%2Fcdn.example.com%2F${sha256}.txt`],
      ["i", infoHash],
      ["alt", "hello.txt"],
    ],
    content: "hello.txt",
  }, secret) as SignedNostrEvent;
}

function message(data: unknown): MessageEvent {
  return new MessageEvent("message", { data: JSON.stringify(data) });
}

class FetchSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = FetchSocket.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    queueMicrotask(() => {
      this.readyState = FetchSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string): void {
    const request = JSON.parse(data) as unknown[];
    if (request[0] !== "REQ") return;
    const subscription = String(request[1]);
    this.dispatchEvent(message(["EOSE", "attacker-controlled-subscription"]));
    this.dispatchEvent(message(["EVENT", subscription, fileEvent()]));
  }

  close(): void {
    this.readyState = FetchSocket.CLOSED;
  }
}

class PublishSocket extends FetchSocket {
  override send(data: string): void {
    const request = JSON.parse(data) as unknown[];
    if (request[0] !== "EVENT") return;
    const event = request[1] as SignedNostrEvent;
    this.dispatchEvent(message(["OK", "00".repeat(32), true, "wrong event"]));
    this.dispatchEvent(message(["OK", event.id, true, "stored"]));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("relay protocol boundaries", () => {
  it("ignores EOSE for another subscription and verifies the exact event", async () => {
    const event = fileEvent();
    const resolved = await fetchFromRelay(
      "wss://relay.example.com",
      event.id,
      "direct",
      FetchSocket as unknown as typeof WebSocket,
    );
    expect(resolved.event.id).toBe(event.id);
  });

  it("waits for an OK tied to the published event ID", async () => {
    const result = await publishToRelay(
      "wss://relay.example.com",
      fileEvent(),
      "direct",
      PublishSocket as unknown as typeof WebSocket,
    );
    expect(result).toMatchObject({ ok: true, message: "stored" });
  });

  it("rejects invalid events before opening a socket", () => {
    const invalid = { ...fileEvent(), sig: "00".repeat(64) };
    expect(() => publishToRelay(
      "wss://relay.example.com",
      invalid,
      "direct",
      PublishSocket as unknown as typeof WebSocket,
    )).toThrow(/invalid/u);
  });

  it("publishes to every deliberately selected relay", async () => {
    vi.stubGlobal("WebSocket", PublishSocket);
    const results = await publishToRelays(["wss://one.example.com", "wss://two.example.com"], fileEvent());
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("closes losing relay lookups as soon as one verified result wins", async () => {
    class MultiSocket extends FetchSocket {
      static instances: MultiSocket[] = [];
      constructor(url: string | URL) {
        super(url);
        MultiSocket.instances.push(this);
      }
      override send(data: string): void {
        const request = JSON.parse(data) as unknown[];
        if (request[0] !== "REQ" || !this.url.includes("fast")) return;
        const subscription = String(request[1]);
        this.dispatchEvent(message(["EVENT", subscription, fileEvent()]));
      }
    }
    vi.stubGlobal("WebSocket", MultiSocket);
    const event = fileEvent();
    const resolved = await resolveFromRelays(["wss://fast.example.com", "wss://slow.example.com"], event.id);
    expect(resolved.event.id).toBe(event.id);
    expect(MultiSocket.instances).toHaveLength(2);
    expect(MultiSocket.instances.every((socket) => socket.readyState === MultiSocket.CLOSED)).toBe(true);
  });

  it("continues past a relay's validly signed split view until the exact event wins", async () => {
    const expected = fileEvent();
    const other = finalizeEvent({
      kind: 1063,
      created_at: 2_001,
      tags: expected.tags,
      content: "another signed event",
    }, secret) as SignedNostrEvent;
    class SplitViewSocket extends FetchSocket {
      override send(data: string): void {
        const request = JSON.parse(data) as unknown[];
        if (request[0] !== "REQ") return;
        const subscription = String(request[1]);
        if (this.url.includes("split")) {
          this.dispatchEvent(message(["EVENT", subscription, other]));
          this.dispatchEvent(message(["EOSE", subscription]));
          return;
        }
        this.dispatchEvent(message(["EVENT", subscription, expected]));
      }
    }
    vi.stubGlobal("WebSocket", SplitViewSocket);
    const resolved = await resolveFromRelays(
      ["wss://split.example.com", "wss://honest.example.com"],
      expected.id,
    );
    expect(resolved.event.id).toBe(expected.id);
  });

  it("rejects invalid IDs and excessive relay fan-out before opening sockets", async () => {
    expect(() => fetchFromRelay(
      "wss://relay.example.com",
      "not-an-event-id",
      "direct",
      FetchSocket as unknown as typeof WebSocket,
    )).toThrow(/Event ID/u);
    const relays = Array.from({ length: 9 }, (_, index) => `wss://relay${index}.example.com`);
    await expect(resolveFromRelays(relays, fileEvent().id)).rejects.toThrow(/At most 8/u);
    await expect(publishToRelays(relays, fileEvent())).rejects.toThrow(/At most 8/u);
  });

  it("closes a pending publication when its authority is invalidated", async () => {
    class SilentPublishSocket extends FetchSocket {
      override send(): void {
        // Deliberately never acknowledge the event.
      }
    }
    const controller = new AbortController();
    const result = publishToRelay(
      "wss://relay.example.com",
      fileEvent(),
      "direct",
      SilentPublishSocket as unknown as typeof WebSocket,
      controller.signal,
    );
    controller.abort();
    await expect(result).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/u) });
  });

  it("opens no relay connection after authority was already cancelled", async () => {
    class CountingSocket extends FetchSocket {
      static constructions = 0;
      constructor(url: string | URL) {
        super(url);
        CountingSocket.constructions += 1;
      }
    }
    const controller = new AbortController();
    controller.abort();
    await expect(publishToRelay(
      "wss://relay.example.com",
      fileEvent(),
      "direct",
      CountingSocket as unknown as typeof WebSocket,
      controller.signal,
    )).resolves.toMatchObject({ ok: false });
    await expect(fetchFromRelay(
      "wss://relay.example.com",
      fileEvent().id,
      "direct",
      CountingSocket as unknown as typeof WebSocket,
      controller.signal,
    )).rejects.toThrow(/cancelled before connection/u);
    expect(CountingSocket.constructions).toBe(0);
  });
});
