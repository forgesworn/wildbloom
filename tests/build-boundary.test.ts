import { describe, expect, it } from "vitest";
import {
  entryReachesWebTorrent,
  isExpectedBrowserWebTorrentModule,
  isForbiddenProductionModule,
  productionChunkContainsNodeIp,
} from "../vite.config";

describe("production WebTorrent build boundary", () => {
  it("accepts only the prebuilt browser bundle on POSIX and Windows", () => {
    expect(isExpectedBrowserWebTorrentModule(
      "/workspace/node_modules/webtorrent/dist/webtorrent.min.js",
    )).toBe(true);
    expect(isExpectedBrowserWebTorrentModule(
      "C:\\workspace\\node_modules\\webtorrent\\dist\\webtorrent.min.js",
    )).toBe(true);
    expect(isForbiddenProductionModule(
      "/workspace/node_modules/webtorrent/index.js",
    )).toBe(true);
  });

  it.each([
    "/workspace/node_modules/ip/lib/ip.js",
    "/workspace/node_modules/bittorrent-tracker/lib/client/udp-tracker.js",
    "/workspace/node_modules/bittorrent-tracker/lib/server/parse-udp.js",
  ])("rejects server-side tracker module %s", (identifier) => {
    expect(isForbiddenProductionModule(identifier)).toBe(true);
  });

  it("accepts unrelated browser modules", () => {
    expect(isForbiddenProductionModule(
      "/workspace/node_modules/nostr-tools/lib/esm/index.js",
    )).toBe(false);
  });

  it("detects the vulnerable Node ip implementation in emitted code", () => {
    expect(productionChunkContainsNodeIp("throw Error(`Invalid ip address: ${value}`)")).toBe(true);
    expect(productionChunkContainsNodeIp("const peerAddress = 'example';")).toBe(false);
  });

  describe("recipient entry", () => {
    function chunk(name: string, moduleIds: string[], imports: string[] = [], isEntry = false, entryName = name) {
      return { type: "chunk", fileName: `assets/${name}.js`, name: entryName, isEntry, moduleIds, imports, dynamicImports: [] };
    }
    const bundle = (chunks: ReturnType<typeof chunk>[]) => Object.fromEntries(chunks.map((item) => [item.fileName, item])) as never;

    it("passes when the recipient entry and its imports hold no WebTorrent", () => {
      expect(entryReachesWebTorrent(bundle([
        chunk("get", ["/src/get/main.ts"], ["assets/shared.js"], true),
        chunk("shared", ["/node_modules/nostr-tools/index.js"]),
        chunk("main", ["/node_modules/webtorrent/dist/webtorrent.min.js"], [], true),
      ]), "get")).toBe(false);
    });

    it("fails when WebTorrent is reachable through a shared chunk", () => {
      expect(entryReachesWebTorrent(bundle([
        chunk("get", ["/src/get/main.ts"], ["assets/shared.js"], true),
        chunk("shared", ["/node_modules/webtorrent/dist/webtorrent.min.js"]),
      ]), "get")).toBe(true);
    });

    it("fails when WebTorrent is in the entry chunk itself, and ignores a missing entry", () => {
      expect(entryReachesWebTorrent(bundle([chunk("get", ["C:\\workspace\\node_modules\\webtorrent\\index.js"], [], true)]), "get")).toBe(true);
      expect(entryReachesWebTorrent(bundle([chunk("main", ["/src/main.ts"], [], true)]), "get")).toBe(false);
    });
  });
});
