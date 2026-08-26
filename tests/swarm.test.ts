import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/core/crypto.js";
import { downloadFromSwarm, startBrowserSeeding, type WebTorrentLoader } from "../src/core/swarm.js";
import type { InspectedFile, ResolvedHybridEvent, TorrentPlan } from "../src/core/types.js";

const infoHash = "cd".repeat(20);
const tracker = "wss://tracker.example.com/";
const webSeed = "https://cdn.example.com/ab";
const privateClientOptions = {
  tracker: { rtcConfig: { iceServers: [] } },
  dht: false,
  lsd: false,
  natPmp: false,
  natUpnp: false,
  utp: false,
};

function loaderFor(clientClass: new (...arguments_: never[]) => object): WebTorrentLoader {
  return async () => ({ default: clientClass as never });
}

function publication(): { inspected: InspectedFile; plan: TorrentPlan } {
  const file = new File(["hello"], "hello.txt", { type: "text/plain" });
  return {
    inspected: { file, name: file.name, extension: "txt", sha256: "ab".repeat(32), size: 5, type: file.type },
    plan: {
      torrentBytes: new Uint8Array([1]),
      torrentBlob: new Blob([new Uint8Array([1])]),
      infoHash,
      magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
      name: file.name,
      trackers: [tracker],
      webSeed,
    },
  };
}

function retrieval(overrides: Partial<ResolvedHybridEvent> = {}): ResolvedHybridEvent {
  return {
    magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
    infoHash,
    trackers: [tracker],
    size: 5,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    ...overrides,
  } as ResolvedHybridEvent;
}

describe("WebTorrent safety boundary", () => {
  it("does not load WebTorrent for seeding or retrieval in Tor-only mode", async () => {
    const { inspected, plan } = publication();
    let loaded = false;
    const loader = async () => {
      loaded = true;
      throw new Error("should not load");
    };
    await expect(startBrowserSeeding(inspected, plan, "tor", loader as WebTorrentLoader)).rejects.toThrow(/disabled/u);
    await expect(downloadFromSwarm(retrieval(), () => undefined, "tor", loader as WebTorrentLoader)).rejects.toThrow(/disabled/u);
    expect(loaded).toBe(false);
  });

  it("does not load WebTorrent when authority was already cancelled", async () => {
    const { inspected, plan } = publication();
    let loaded = false;
    const loader = async () => {
      loaded = true;
      throw new Error("should not load");
    };
    const controller = new AbortController();
    controller.abort();
    await expect(startBrowserSeeding(inspected, plan, "direct", loader as WebTorrentLoader, controller.signal)).rejects.toThrow(/cancelled/u);
    await expect(downloadFromSwarm(retrieval(), () => undefined, "direct", loader as WebTorrentLoader, controller.signal)).rejects.toThrow(/cancelled/u);
    expect(loaded).toBe(false);
  });

  it("disables undeclared STUN, DHT and local-discovery infrastructure", async () => {
    let options: unknown;
    class Client {
      constructor(value: unknown) { options = value; }
      on(): void {}
      seed(_file: File, _options: unknown, callback: (torrent: { infoHash: string }) => void): void { callback({ infoHash }); }
      destroy(callback?: () => void): void { callback?.(); }
    }
    const { inspected, plan } = publication();
    const session = await startBrowserSeeding(inspected, plan, "direct", loaderFor(Client));
    expect(options).toEqual(privateClientOptions);
    await session.stop();
  });

  it("destroys a seeding client if WebTorrent changes the reviewed info hash", async () => {
    class Client {
      static last: Client;
      destroyed = false;
      constructor() { Client.last = this; }
      on(): void {}
      seed(_file: File, _options: unknown, callback: (torrent: { infoHash: string }) => void): void {
        callback({ infoHash: "ef".repeat(20) });
      }
      destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
    }
    const { inspected, plan } = publication();
    await expect(startBrowserSeeding(inspected, plan, "direct", loaderFor(Client))).rejects.toThrow(/different info hash/u);
    expect(Client.last.destroyed).toBe(true);
  });

  it("returns a stoppable session only after matching reviewed metadata", async () => {
    class Client {
      static last: Client;
      destroyed = false;
      destroyCalls = 0;
      constructor() { Client.last = this; }
      on(): void {}
      seed(_file: File, _options: unknown, callback: (torrent: { infoHash: string }) => void): void { callback({ infoHash }); }
      destroy(callback?: () => void): void { this.destroyCalls += 1; this.destroyed = true; callback?.(); }
    }
    const { inspected, plan } = publication();
    const session = await startBrowserSeeding(inspected, plan, "direct", loaderFor(Client));
    expect(Client.last.destroyed).toBe(false);
    await Promise.all([session.stop(), session.stop()]);
    expect(Client.last.destroyed).toBe(true);
    expect(Client.last.destroyCalls).toBe(1);
  });

  it("cancels WebTorrent startup and destroys the client", async () => {
    class Client {
      static last: Client;
      destroyed = false;
      constructor() { Client.last = this; }
      on(): void {}
      seed(): void {}
      destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
    }
    const { inspected, plan } = publication();
    const controller = new AbortController();
    const result = startBrowserSeeding(inspected, plan, "direct", loaderFor(Client), controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toThrow(/cancelled/u);
    expect(Client.last.destroyed).toBe(true);
  });

  it("does not construct a seeding client when cancellation wins during module loading", async () => {
    const { inspected, plan } = publication();
    let releaseLoader: ((value: { default: never }) => void) | undefined;
    let constructions = 0;
    class Client {
      constructor() { constructions += 1; }
    }
    const loader = () => new Promise<{ default: never }>((resolve) => { releaseLoader = resolve; });
    const controller = new AbortController();
    const result = startBrowserSeeding(inspected, plan, "direct", loader, controller.signal);
    controller.abort();
    releaseLoader?.({ default: Client as never });
    await expect(result).rejects.toThrow(/cancelled/u);
    expect(constructions).toBe(0);
  });

  it("destroys a seeding client after a dependency error", async () => {
    class Client {
      static last: Client;
      destroyed = false;
      errorListener: ((error: Error) => void) | undefined;
      constructor() { Client.last = this; }
      on(event: string, listener: (error: Error) => void): void {
        if (event === "error") this.errorListener = listener;
      }
      seed(): void {}
      destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
    }
    const { inspected, plan } = publication();
    const result = startBrowserSeeding(inspected, plan, "direct", loaderFor(Client));
    await Promise.resolve();
    Client.last.errorListener?.(new Error("tracker refused\u0000connection"));
    await expect(result).rejects.toThrow("WebTorrent failed: tracker refused connection");
    expect(Client.last.destroyed).toBe(true);
  });

  it("bounds startup and cleanup rather than claiming an unconfirmed stop", async () => {
    vi.useFakeTimers();
    try {
      class SlowStartClient {
        static last: SlowStartClient;
        destroyed = false;
        constructor() { SlowStartClient.last = this; }
        on(): void {}
        seed(): void {}
        destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
      }
      const { inspected, plan } = publication();
      const starting = startBrowserSeeding(inspected, plan, "direct", loaderFor(SlowStartClient));
      const startupRejection = expect(starting).rejects.toThrow(/safety timeout/u);
      await vi.advanceTimersByTimeAsync(30_000);
      await startupRejection;
      expect(SlowStartClient.last.destroyed).toBe(true);

      class UnconfirmedStopClient {
        on(): void {}
        seed(_file: File, _options: unknown, callback: (torrent: { infoHash: string }) => void): void {
          callback({ infoHash });
        }
        destroy(): void {}
      }
      const session = await startBrowserSeeding(inspected, plan, "direct", loaderFor(UnconfirmedStopClient));
      const stopping = session.stop();
      const cleanupRejection = expect(stopping).rejects.toThrow(/cleanup timed out/u);
      await vi.advanceTimersByTimeAsync(5_000);
      await cleanupRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a cleanup error alongside the original metadata failure", async () => {
    class Client {
      on(): void {}
      seed(_file: File, _options: unknown, callback: (torrent: { infoHash: string }) => void): void {
        callback({ infoHash: "ef".repeat(20) });
      }
      destroy(callback?: (error?: Error) => void): void { callback?.(new Error("peer socket remained open")); }
    }
    const { inspected, plan } = publication();
    await expect(startBrowserSeeding(inspected, plan, "direct", loaderFor(Client)))
      .rejects.toThrow(/different info hash.*cleanup failed.*socket remained open/u);
  });

  it("verifies torrent metadata and final SHA-256 before returning bytes", async () => {
    const bytes = new Blob(["hello"], { type: "text/plain" });
    const hash = await sha256Hex(bytes);
    const resolved = {
      magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
      infoHash,
      trackers: [tracker],
      size: 5,
      sha256: hash,
    } as unknown as ResolvedHybridEvent;
    let options: unknown;
    class Client {
      static last: Client;
      destroyed = false;
      constructor(value: unknown) { Client.last = this; options = value; }
      on(): void {}
      add(_magnet: string, _options: unknown, callback: (torrent: object) => void): void {
        callback({
          infoHash,
          length: 5,
          progress: 1,
          downloadSpeed: 100,
          files: [{ length: 5, blob: async () => bytes }],
          on: (event: string, listener: () => void) => { if (event === "download") listener(); },
        });
      }
      destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
    }
    let progress = 0;
    const result = await downloadFromSwarm(resolved, (value) => { progress = value; }, "direct", loaderFor(Client));
    expect(await result.blob.text()).toBe("hello");
    expect(progress).toBe(1);
    expect(options).toEqual(privateClientOptions);
    await result.session.stop();
    expect(Client.last.destroyed).toBe(true);
  });

  it("rejects missing or conflicting signed torrent metadata before bytes are exposed", async () => {
    const missing = { trackers: [] } as unknown as ResolvedHybridEvent;
    await expect(downloadFromSwarm(missing, () => undefined)).rejects.toThrow(/usable/u);

    class Client {
      destroyed = false;
      on(): void {}
      add(_magnet: string, _options: unknown, callback: (torrent: object) => void): void {
        callback({ infoHash: "ef".repeat(20), length: 5, files: [] });
      }
      destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
    }
    const resolved = {
      magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
      infoHash,
      trackers: [tracker],
      size: 5,
      sha256: "ab".repeat(32),
    } as unknown as ResolvedHybridEvent;
    await expect(downloadFromSwarm(resolved, () => undefined, "direct", loaderFor(Client))).rejects.toThrow(/does not match/u);
  });

  it("destroys the client for multi-file metadata or bytes with the wrong signed hash", async () => {
    class MultiFileClient {
      static last: MultiFileClient;
      destroyed = false;
      constructor() { MultiFileClient.last = this; }
      on(): void {}
      add(_magnet: string, _options: unknown, callback: (torrent: object) => void): void {
        callback({
          infoHash,
          length: 5,
          files: [{ length: 3 }, { length: 2 }],
        });
      }
      destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
    }
    await expect(downloadFromSwarm(retrieval(), () => undefined, "direct", loaderFor(MultiFileClient)))
      .rejects.toThrow(/one-file torrents/u);
    expect(MultiFileClient.last.destroyed).toBe(true);

    class WrongBytesClient {
      static last: WrongBytesClient;
      destroyed = false;
      constructor() { WrongBytesClient.last = this; }
      on(): void {}
      add(_magnet: string, _options: unknown, callback: (torrent: object) => void): void {
        callback({
          infoHash,
          length: 5,
          files: [{ length: 5, blob: async () => new Blob(["world"]) }],
          on: () => undefined,
        });
      }
      destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
    }
    await expect(downloadFromSwarm(retrieval(), () => undefined, "direct", loaderFor(WrongBytesClient)))
      .rejects.toThrow(/signed SHA-256/u);
    expect(WrongBytesClient.last.destroyed).toBe(true);
  });

  it("times out a swarm download and confirms client cleanup", async () => {
    vi.useFakeTimers();
    try {
      class Client {
        static last: Client;
        destroyed = false;
        constructor() { Client.last = this; }
        on(): void {}
        add(): void {}
        destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
      }
      const result = downloadFromSwarm(retrieval(), () => undefined, "direct", loaderFor(Client));
      const rejection = expect(result).rejects.toThrow(/timed out/u);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await rejection;
      expect(Client.last.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys the client when the real promise-based file read fails", async () => {
    class Client {
      static last: Client;
      destroyed = false;
      constructor() { Client.last = this; }
      on(): void {}
      add(_magnet: string, _options: unknown, callback: (torrent: object) => void): void {
        callback({
          infoHash,
          length: 5,
          files: [{ length: 5, blob: async () => { throw new Error("store interrupted"); } }],
          on: () => undefined,
        });
      }
      destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
    }
    const resolved = {
      magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
      infoHash,
      trackers: [tracker],
      size: 5,
      sha256: "ab".repeat(32),
    } as unknown as ResolvedHybridEvent;
    await expect(downloadFromSwarm(resolved, () => undefined, "direct", loaderFor(Client))).rejects.toThrow(/store interrupted/u);
    expect(Client.last.destroyed).toBe(true);
  });

  it("cancels an in-flight swarm before exposing bytes", async () => {
    class Client {
      static last: Client;
      destroyed = false;
      added = false;
      constructor() { Client.last = this; }
      on(): void {}
      add(): void { this.added = true; }
      destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
    }
    const resolved = {
      magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
      infoHash,
      trackers: [tracker],
      size: 5,
      sha256: "ab".repeat(32),
    } as unknown as ResolvedHybridEvent;
    const controller = new AbortController();
    const result = downloadFromSwarm(resolved, () => undefined, "direct", loaderFor(Client), controller.signal);
    await Promise.resolve();
    expect(Client.last.added).toBe(true);
    controller.abort();
    await expect(result).rejects.toThrow(/cancelled/u);
    expect(Client.last.destroyed).toBe(true);
  });

  it("does not construct a peer client when cancellation wins during module loading", async () => {
    let releaseLoader: ((value: { default: never }) => void) | undefined;
    let constructions = 0;
    class Client {
      constructor() { constructions += 1; }
    }
    const loader = () => new Promise<{ default: never }>((resolve) => { releaseLoader = resolve; });
    const resolved = {
      magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
      infoHash,
      trackers: [tracker],
      size: 5,
      sha256: "ab".repeat(32),
    } as unknown as ResolvedHybridEvent;
    const controller = new AbortController();
    const result = downloadFromSwarm(resolved, () => undefined, "direct", loader, controller.signal);
    controller.abort();
    releaseLoader?.({ default: Client as never });
    await expect(result).rejects.toThrow(/cancelled/u);
    expect(constructions).toBe(0);
  });
});
