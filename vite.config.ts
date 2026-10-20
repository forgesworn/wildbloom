import type { Connect, Plugin, Rollup } from "vite";
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

/** True when any chunk statically or dynamically reachable from the entry holds a WebTorrent module. */
export function entryReachesWebTorrent(bundle: Rollup.OutputBundle, entryName: string): boolean {
  const chunks = Object.values(bundle).filter((output): output is Rollup.OutputChunk => output.type === "chunk");
  const entry = chunks.find((chunk) => chunk.isEntry && chunk.name === entryName);
  if (!entry) return false;
  const seen = new Set<string>([entry.fileName]);
  const queue = [entry];
  while (queue.length > 0) {
    const chunk = queue.pop()!;
    if (chunk.moduleIds.some((id) => normaliseModuleIdentifier(id).includes("/node_modules/webtorrent/"))) return true;
    for (const name of [...chunk.imports, ...chunk.dynamicImports]) {
      const next = chunks.find((candidate) => candidate.fileName === name);
      if (next && !seen.has(name)) {
        seen.add(name);
        queue.push(next);
      }
    }
  }
  return false;
}

/** The standalone pairing pages: `/get` receives a file, `/send` sends one. Each is its own HTML entry. */
const PAIRING_PAGES = ["get", "send"] as const;

/**
 * Serve the pairing pages at /get and /send in dev and preview. Without this
 * the SPA fallback answers with the main client, and a trailing slash would
 * break relative assets.
 */
function servePairingRoutes(): Plugin {
  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = request.url ?? "";
    const queryStart = url.indexOf("?");
    const path = (queryStart < 0 ? url : url.slice(0, queryStart)).split("#")[0];
    const query = queryStart < 0 ? "" : url.slice(queryStart);
    for (const page of PAIRING_PAGES) {
      if (path === `/${page}/`) {
        response.statusCode = 301;
        response.setHeader("Location", `/${page}${query}`);
        response.end();
        return;
      }
      if (path === `/${page}`) request.url = `/${page}.html${query}`;
    }
    next();
  };
  return {
    name: "wildbloom-pairing-routes",
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
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
      for (const page of PAIRING_PAGES) {
        if (entryReachesWebTorrent(bundle, page)) this.error(`The /${page} page must never include WebTorrent.`);
      }
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk" && productionChunkContainsNodeIp(output.code)) {
          this.error(`Production chunk ${output.fileName} contains the vulnerable Node ip implementation.`);
        }
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [servePairingRoutes(), enforceBrowserWebTorrentBoundary()],
  resolve: {
    // create-torrent and parse-torrent expose browser implementations for
    // filesystem access but still use POSIX path operations for metadata.
    alias: { path: "path-browserify" },
  },
  build: {
    target: "es2022",
    rollupOptions: { input: { main: "index.html", get: "get.html", send: "send.html" } },
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
