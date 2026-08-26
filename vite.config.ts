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
  test: {
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts"],
      exclude: ["src/core/types.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 90,
      },
    },
  },
});
