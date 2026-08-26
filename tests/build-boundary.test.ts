import { describe, expect, it } from "vitest";
import {
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
});
