import { describe, expect, it } from "vitest";
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

describe("WebTorrent safety boundary", () => {
  it("does not load WebTorrent at all in Tor-only mode", async () => {
    const { inspected, plan } = publication();
    let loaded = false;
    const loader = async () => {
      loaded = true;
      throw new Error("should not load");
    };
    await expect(startBrowserSeeding(inspected, plan, "tor", loader as WebTorrentLoader)).rejects.toThrow(/disabled/u);
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
      constructor() { Client.last = this; }
      on(): void {}
      seed(_file: File, _options: unknown, callback: (torrent: { infoHash: string }) => void): void { callback({ infoHash }); }
      destroy(callback?: () => void): void { this.destroyed = true; callback?.(); }
    }
    const { inspected, plan } = publication();
    const session = await startBrowserSeeding(inspected, plan, "direct", loaderFor(Client));
    expect(Client.last.destroyed).toBe(false);
    await session.stop();
    expect(Client.last.destroyed).toBe(true);
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
          files: [{ length: 5, getBlob: (done: (error: Error | null, blob: Blob) => void) => done(null, bytes) }],
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
});
