import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const BROWSER_WEBTORRENT_MODULE = "/node_modules/webtorrent/dist/webtorrent.min.js";
const FORBIDDEN_TRACKER_MODULES = [
  "/node_modules/ip/",
  "/node_modules/bittorrent-tracker/lib/client/udp-tracker.js",
  "/node_modules/bittorrent-tracker/lib/server/",
];

function normaliseModuleIdentifier(identifier: string): string {
  return identifier.replaceAll("\\", "/");
}

export function isExpectedBrowserWebTorrentModule(identifier: string): boolean {
  return normaliseModuleIdentifier(identifier).endsWith(BROWSER_WEBTORRENT_MODULE);
}

export function isForbiddenProductionModule(identifier: string): boolean {
  const normalised = normaliseModuleIdentifier(identifier);
  return FORBIDDEN_TRACKER_MODULES.some((forbidden) => normalised.includes(forbidden))
    || (normalised.includes("/node_modules/webtorrent/") && !isExpectedBrowserWebTorrentModule(normalised));
}

export function productionChunkContainsNodeIp(code: string): boolean {
  return code.includes("Invalid ip address:");
}

function enforceBrowserWebTorrentBoundary(): Plugin {
  let browserBundleLoaded = false;
  return {
    name: "wildbloom-browser-webtorrent-boundary",
    moduleParsed(module) {
      if (isForbiddenProductionModule(module.id)) {
        this.error(`Production included forbidden Node tracker code: ${module.id}`);
      }
      if (isExpectedBrowserWebTorrentModule(module.id)) browserBundleLoaded = true;
    },
    generateBundle(_options, bundle) {
      if (!browserBundleLoaded) this.error("Production did not include the expected WebTorrent browser bundle.");
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk" && productionChunkContainsNodeIp(output.code)) {
          this.error(`Production chunk ${output.fileName} contains the vulnerable Node ip implementation.`);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [enforceBrowserWebTorrentBoundary()],
  resolve: {
    // create-torrent and parse-torrent expose browser implementations for
    // filesystem access but still use POSIX path operations for metadata.
    alias: { path: "path-browserify" },
  },
  build: {
    target: "es2022",
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts"],
      exclude: ["src/core/types.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 88,
        lines: 94,
      },
    },
  },
});
