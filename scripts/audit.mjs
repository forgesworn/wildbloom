import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// npm reports GHSA-2p57-rm9w-gvfp through WebTorrent's Node-only UDP tracker
// server parser. Wildbloom imports WebTorrent's prebuilt browser bundle, whose
// package maps both the server and UDP client out of browser builds. Keep this
// exception fail-closed: it is accepted only while those exact reachability
// facts remain true. Any other advisory fails the build.
const ALLOWED_ADVISORY = "GHSA-2p57-rm9w-gvfp";

let report;
try {
  const output = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  report = JSON.parse(output);
} catch (error) {
  const output = error?.stdout;
  if (typeof output !== "string") throw error;
  report = JSON.parse(output);
}

const trackerPackage = JSON.parse(readFileSync("node_modules/bittorrent-tracker/package.json", "utf8"));
const browserMap = trackerPackage.browser ?? {};
const parser = readFileSync("node_modules/bittorrent-tracker/lib/server/parse-udp.js", "utf8");
const reachabilityGuard = browserMap["./server.js"] === false
  && browserMap["./lib/client/udp-tracker.js"] === false
  && parser.includes("from 'ip'");

const vulnerabilities = report.vulnerabilities ?? {};
const memo = new Map();
function isAllowed(name, stack = new Set()) {
  if (memo.has(name)) return memo.get(name);
  if (stack.has(name)) return false;
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || !Array.isArray(vulnerability.via)) return false;
  const next = new Set(stack).add(name);
  const allowed = vulnerability.via.length > 0 && vulnerability.via.every((cause) => {
    if (typeof cause === "string") return isAllowed(cause, next);
    return typeof cause?.url === "string" && cause.url.endsWith(ALLOWED_ADVISORY);
  });
  memo.set(name, allowed);
  return allowed;
}

const unexpected = Object.keys(vulnerabilities).filter((name) => !isAllowed(name));
const allowed = Object.keys(vulnerabilities).filter((name) => isAllowed(name));

if (unexpected.length > 0 || (allowed.length > 0 && !reachabilityGuard)) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!reachabilityGuard) process.stderr.write("The WebTorrent browser-only advisory guard no longer holds.\n");
  if (unexpected.length > 0) process.stderr.write(`Unexpected vulnerable packages: ${unexpected.join(", ")}\n`);
  process.exit(1);
}

if (allowed.length > 0) {
  process.stdout.write(`Audit passed with one browser-unreachable Node-only exception (${ALLOWED_ADVISORY}: ${allowed.join(", ")}).\n`);
} else {
  process.stdout.write("Audit passed with no known vulnerabilities.\n");
}
