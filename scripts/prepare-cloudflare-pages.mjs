import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONTENT_SECURITY_POLICY, PERMISSIONS_POLICY } from "./http-security.mjs";
import { loadProductionBuild } from "./production-build.mjs";

const root = resolve(process.cwd(), "dist");
loadProductionBuild(root);

const securityHeaders = [
  `  Content-Security-Policy: ${CONTENT_SECURITY_POLICY}`,
  "  Cross-Origin-Opener-Policy: same-origin",
  "  Cross-Origin-Resource-Policy: same-origin",
  `  Permissions-Policy: ${PERMISSIONS_POLICY}`,
  "  Referrer-Policy: no-referrer",
  "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
  "  X-Content-Type-Options: nosniff",
  "  X-Frame-Options: DENY",
];

const headers = [
  "/*",
  ...securityHeaders,
  "/",
  "  Cache-Control: no-store",
  "/index.html",
  "  Cache-Control: no-store",
  "/healthz",
  "  Cache-Control: no-store",
  "  Content-Type: application/json; charset=utf-8",
  "/assets/*",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
].join("\n");

await Promise.all([
  writeFile(resolve(root, "_headers"), headers, { encoding: "utf8", flag: "wx" }),
  writeFile(resolve(root, "healthz"), '{"status":"ok"}\n', { encoding: "utf8", flag: "wx" }),
]);
