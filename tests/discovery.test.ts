import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildServerList,
  discoverNodes,
  serverList,
} from "../src/core/discovery.js";
import type { SignedNostrEvent } from "../src/core/types.js";
const now = 1800000000;
const secret = new Uint8Array(32).fill(42),
  second = new Uint8Array(32).fill(43);
const author = getPublicKey(secret),
  other = getPublicKey(second);
function event(
  origins = ["https://node.example/"],
  time = now,
  key = secret,
): SignedNostrEvent {
  return finalizeEvent(
    { ...buildServerList(origins, "direct"), created_at: time },
    key,
  );
}
function socketFor(events: unknown[], mode = "ok"): typeof WebSocket {
  return class extends EventTarget {
    readyState = 0;
    constructor(_url: string) {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(data: string): void {
      const request = JSON.parse(data);
      if (request[0] !== "REQ") return;
      expect(request[2]).toMatchObject({
        kinds: [10063],
        since: now - 30 * 86400,
      });
      if (mode === "silent") return;
      if (mode === "error" || mode === "close") {
        this.dispatchEvent(new Event(mode));
        return;
      }
      const emit = (data: unknown): void => {
        this.dispatchEvent(new MessageEvent("message", { data }));
      };
      emit("invalid JSON");
      emit(JSON.stringify({ bad: "shape" }));
      emit(JSON.stringify(["EOSE", "wrong-subscription"]));
      emit(JSON.stringify(["NOTICE", request[1]]));
      if (mode === "oversized") {
        emit("x".repeat(32769));
        return;
      }
      if (mode === "binary") {
        emit(new Uint8Array(1));
        return;
      }
      if (mode === "flood") {
        for (let i = 0; i < 260; i++) emit("invalid");
        return;
      }
      for (const e of events) emit(JSON.stringify(["EVENT", request[1], e]));
      emit(JSON.stringify(["EOSE", request[1]]));
      emit(JSON.stringify(["EVENT", request[1], events[0]]));
    }
    close(): void {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  } as unknown as typeof WebSocket;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("trusted Blossom server discovery", () => {
  it("validates signed lists and ignores endpoints outside the active profile", () => {
    const signed = event(["https://node.example/", "https://node.example"]);
    expect(serverList(signed, [author], "direct", now).origins).toEqual([
      "https://node.example/",
    ]);
    expect(serverList(signed, [author], "tor", now).origins).toEqual([]);
    expect(
      buildServerList(
        ["https://node.example", "https://node.example/"],
        "direct",
      ).tags,
    ).toHaveLength(1);
    for (const urls of [[], Array(17).fill("https://node.example")])
      expect(() => buildServerList(urls, "direct")).toThrow();
    for (const bad of [
      null,
      {},
      event(undefined, now - 30 * 86400 - 1),
      event(undefined, now + 31),
      event(undefined, now, second),
      { ...JSON.parse(JSON.stringify(signed)), sig: "00".repeat(64) },
    ])
      expect(() => serverList(bad, [author], "direct", now)).toThrow();
    for (const changes of [
      { kind: 1063 },
      { content: "not-empty" },
      { tags: [] },
      { tags: [["server", "https://node.example", "extra"]] },
      { tags: Array(17).fill(["server", "https://node.example"]) },
      { tags: Array(65).fill(["other"]) },
      { content: "x".repeat(17000) },
    ])
      expect(() =>
        serverList(
          finalizeEvent({ ...signed, ...changes }, secret),
          [author],
          "direct",
          now,
        ),
      ).toThrow();
  });
  it("uses only each author's latest list and merges trusted recommendations without probing nodes", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const events = [
      event(["https://old.example"], now - 1),
      event(),
      event(["https://node.example", "https://second.example"], now, second),
      {},
      event(["https://stale.example"], now - 31 * 86400),
    ];
    const nodes = await discoverNodes(
      ["wss://relay.example"],
      [author, other],
      { now, WebSocketImpl: socketFor(events) },
    );
    expect(nodes).toEqual([
      {
        origin: "https://node.example/",
        recommendedBy: [author, other],
        updatedAt: now,
      },
      {
        origin: "https://second.example/",
        recommendedBy: [other],
        updatedAt: now,
      },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("resolves equal timestamps by the lowest event ID and ignores one failed relay", async () => {
    const a = event(["https://a.example"]),
      b = event(["https://b.example"]);
    const winner = a.id < b.id ? a : b;
    const Good = socketFor([b, a]);
    const Bad = socketFor([], "error");
    class Multi {
      constructor(url: string) {
        return new (url.includes("bad") ? Bad : Good)(url);
      }
    }
    vi.stubGlobal("WebSocket", Multi);
    const result = await discoverNodes(
      ["wss://bad.example", "wss://good.example"],
      [author],
      { now },
    );
    expect(result[0]!.origin).toBe(winner.tags[0]![1]);
  });
  it.each(["error", "close", "oversized", "binary", "flood"])(
    "bounds and rejects %s relay responses",
    async (mode) => {
      await expect(
        discoverNodes(["wss://relay.example"], [author], {
          now,
          WebSocketImpl: socketFor([], mode),
        }),
      ).rejects.toThrow(/No relay/u);
    },
  );
  it("closes subscriptions on timeout and authority cancellation", async () => {
    vi.useFakeTimers();
    const options = {
      now,
      WebSocketImpl: socketFor([], "silent"),
      timeoutMs: 10,
    };
    const timeout = expect(
      discoverNodes(["wss://relay.example"], [author], options),
    ).rejects.toThrow(/No relay/u);
    await vi.advanceTimersByTimeAsync(11);
    await timeout;
    const controller = new AbortController();
    const task = discoverNodes(["wss://relay.example"], [author], {
      ...options,
      signal: controller.signal,
    });
    controller.abort();
    await expect(task).rejects.toThrow();
    await expect(
      discoverNodes(["wss://relay.example"], [author], {
        ...options,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    for (const [relays, keys] of [
      [[], [author]],
      [["wss://relay.example"], []],
      [Array(9).fill("wss://relay.example"), [author]],
      [["wss://relay.example"], Array(17).fill(author)],
    ])
      await expect(discoverNodes(relays!, keys!, options)).rejects.toThrow(
        /bounded/u,
      );
  });
});
