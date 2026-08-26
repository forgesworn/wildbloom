import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // create-torrent and parse-torrent expose browser implementations for
    // filesystem access but still use POSIX path operations for metadata.
    alias: { path: "path-browserify" },
  },
  build: {
    target: "es2022",
  },
});
