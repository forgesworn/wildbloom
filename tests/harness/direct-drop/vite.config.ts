import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The test receiver is built on its own, never as part of the production build:
// scripts/direct-acceptance.mjs runs `vite build --config` on this file into a
// temporary directory. The production config lists only the three real pages.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  build: { target: "es2022" },
});
