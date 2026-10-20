import { readFileSync } from "node:fs";
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

  describe.each([["get", "recipient"], ["send", "sender"]] as const)("%s entry (%s page)", (name, _role) => {
    function chunk(chunkName: string, moduleIds: string[], imports: string[] = [], isEntry = false, entryName = chunkName) {
      return { type: "chunk", fileName: `assets/${chunkName}.js`, name: entryName, isEntry, moduleIds, imports, dynamicImports: [] };
    }
    const bundle = (chunks: ReturnType<typeof chunk>[]) => Object.fromEntries(chunks.map((item) => [item.fileName, item])) as never;

    it("passes when the entry and its imports hold no WebTorrent", () => {
      expect(entryReachesWebTorrent(bundle([
        chunk(name, [`/src/${name}/main.ts`], ["assets/shared.js"], true),
        chunk("shared", ["/node_modules/nostr-tools/index.js"]),
        chunk("main", ["/node_modules/webtorrent/dist/webtorrent.min.js"], [], true),
      ]), name)).toBe(false);
    });

    it("fails when WebTorrent is reachable through a shared chunk", () => {
      expect(entryReachesWebTorrent(bundle([
        chunk(name, [`/src/${name}/main.ts`], ["assets/shared.js"], true),
        chunk("shared", ["/node_modules/webtorrent/dist/webtorrent.min.js"]),
      ]), name)).toBe(true);
    });

    it("fails when WebTorrent is in the entry chunk itself, and ignores a missing entry", () => {
      expect(entryReachesWebTorrent(bundle([chunk(name, ["C:\\workspace\\node_modules\\webtorrent\\index.js"], [], true)]), name)).toBe(true);
      expect(entryReachesWebTorrent(bundle([chunk("main", ["/src/main.ts"], [], true)]), name)).toBe(false);
    });
  });

  it("builds the sender page as its own entry and guards both pairing pages", () => {
    const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(config).toContain('send: "send.html"');
    expect(config).toContain('const PAIRING_PAGES = ["get", "send"] as const;');
    expect(config).toContain("entryReachesWebTorrent(bundle, page)");
    expect(readFileSync(new URL("../send.html", import.meta.url), "utf8")).toContain('src="/src/send/main.ts"');
  });

  it("keeps the direct send test receiver out of the production build", () => {
    const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(config).toContain('input: { main: "index.html", get: "get.html", send: "send.html" }');
    expect(config).not.toMatch(/harness|direct-drop/u);
    // It has a build of its own, which only the acceptance script runs.
    expect(readFileSync(new URL("./harness/direct-drop/vite.config.ts", import.meta.url), "utf8")).toContain("direct-acceptance.mjs");
    expect(readFileSync(new URL("../scripts/direct-acceptance.mjs", import.meta.url), "utf8")).toContain("tests/harness/direct-drop/vite.config.ts");
  });
});
