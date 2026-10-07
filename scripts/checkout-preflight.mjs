import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 64 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
class PreflightError extends Error {}
function requireCheck(condition, message) {
  if (!condition) throw new PreflightError(message);
}

function origin(value, allowLoopback) {
  let url;
  try { url = new URL(value); } catch { throw new PreflightError("An exact origin is required."); }
  requireCheck(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "Origins must not contain credentials, paths, queries or fragments.");
  requireCheck(!url.hostname.endsWith(".onion"), "Checkout preflight is direct-mode only.");
  const local = ["127.0.0.1", "[::1]"].includes(url.hostname);
  requireCheck(url.protocol === "https:" || (allowLoopback && local && url.protocol === "http:"), "HTTPS is required; HTTP needs an explicit loopback exception.");
  return url.origin;
}

export function parseArguments(args) {
  const values = {};
  const flags = new Set(["--node", "--app", "--offer", "--rail", "--max-sats", "--output"]);
  let allowLoopback = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--allow-loopback-http") {
      requireCheck(!allowLoopback, "Duplicate loopback option.");
      allowLoopback = true;
      continue;
    }
    requireCheck(flags.has(flag) && values[flag] === undefined, "Unknown or duplicate option.");
    requireCheck(args[i + 1] && !args[i + 1].startsWith("--"), "Missing option value.");
    values[flag] = args[++i];
  }
  for (const flag of flags) requireCheck(values[flag], "Required: --node --app --offer --rail --max-sats --output.");
  requireCheck(/^[a-zA-Z0-9_-]{1,128}$/u.test(values["--offer"]), "Invalid offer identifier.");
  requireCheck(["lightning", "lnurlcash"].includes(values["--rail"]), "Choose lightning or lnurlcash.");
  requireCheck(/^[1-9][0-9]*$/u.test(values["--max-sats"]), "The test ceiling must be a positive whole number of sats.");
  const maxSats = Number(values["--max-sats"]);
  requireCheck(Number.isSafeInteger(maxSats * 1000), "The test ceiling is too large.");
  return {
    node: origin(values["--node"], allowLoopback),
    app: origin(values["--app"], allowLoopback),
    offer: values["--offer"], rail: values["--rail"], maxSats,
    output: resolve(values["--output"]),
  };
}

async function boundedBody(response) {
  requireCheck(response.body, "Offers response has no body.");
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCheck(size <= MAX_BYTES, "Offers response exceeds 64 KiB.");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts);
}

function tokens(headers, name) {
  return (headers.get(name) ?? "").toLowerCase().split(",").map((s) => s.trim());
}

// Only public GET and browser OPTIONS requests. No signer, credentials, orders,
// invoices, wallet calls, payment checks or uploads are made by this command.
export async function runPreflight(options, fetcher = fetch) {
  const get = await fetcher(`${options.node}/checkout/v1/offers`, {
    method: "GET", headers: { Origin: options.app, Accept: "application/json" },
    redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000),
  });
  // Consume/cancel even rejected responses so a hostile endpoint cannot retain
  // the connection indefinitely. The same deadline covers headers and body.
  let bytes;
  try {
    requireCheck(get.status === 200, "Offers endpoint must return HTTP 200 without a redirect.");
    requireCheck(get.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json", "Offers endpoint must return JSON.");
    requireCheck(tokens(get.headers, "cache-control").includes("no-store"), "Offers response must use Cache-Control: no-store.");
    requireCheck(get.headers.get("access-control-allow-origin") === options.app, "Offers CORS must allow the exact browser origin.");
    bytes = await boundedBody(get);
  } finally { if (!get.body?.locked) await get.body?.cancel().catch(() => {}); }
  let offers;
  try { offers = JSON.parse(bytes.toString("utf8")); } catch { throw new PreflightError("Offers response is not valid JSON."); }
  requireCheck(offers?.version === 1 && offers.node_origin === `${options.node}/`, "Offers version or node-origin binding is invalid.");
  requireCheck(offers.network === "bitcoin", "This live-payment ceremony requires Bitcoin mainnet.");
  requireCheck(Array.isArray(offers.rails) && offers.rails.includes(options.rail), "Selected payment rail is unavailable.");
  requireCheck(Array.isArray(offers.offers) && offers.offers.length <= 32, "Invalid offers list.");
  const matches = offers.offers.filter((o) => o?.id === options.offer);
  requireCheck(matches.length === 1, "The selected offer must appear exactly once.");
  const offer = matches[0];
  requireCheck(Number.isSafeInteger(offer.price_msat) && offer.price_msat > 0 && offer.price_msat % 1000 === 0, "Offer price must be positive whole sats.");
  requireCheck(offer.price_msat <= options.maxSats * 1000, "Offer exceeds the stated test ceiling.");
  requireCheck(Number.isSafeInteger(offer.capacity_bytes) && offer.capacity_bytes > 0, "Offer capacity is invalid.");
  for (const field of ["delivery_policy", "retention_policy", "refund_policy"]) {
    requireCheck(typeof offer[field] === "string" && offer[field].trim().length > 0 && offer[field].length <= 2048, "Offer policy terms are missing or oversized.");
  }
  const preflight = await fetcher(`${options.node}/checkout/v1/orders`, {
    method: "OPTIONS",
    headers: { Origin: options.app, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000),
  });
  try {
    requireCheck(preflight.ok, "Order CORS preflight failed.");
    requireCheck(preflight.headers.get("access-control-allow-origin") === options.app, "Order CORS must allow the exact browser origin.");
    requireCheck(tokens(preflight.headers, "access-control-allow-methods").includes("post"), "Order CORS must allow POST.");
    const headers = tokens(preflight.headers, "access-control-allow-headers");
    requireCheck(headers.includes("authorization") && headers.includes("content-type"), "Order CORS must allow authorisation and content type.");
  } finally { await preflight.body?.cancel().catch(() => {}); }
  return {
    schema: "wildbloom-checkout-preflight-v1", status: "preflight-passed",
    checkedAt: new Date().toISOString(),
    nodeOriginSha256: hash(options.node), appOriginSha256: hash(options.app),
    offersResponseSha256: hash(bytes), offerIdSha256: hash(options.offer),
    rail: options.rail, priceSats: offer.price_msat / 1000,
    maxSats: options.maxSats, capacityBytes: offer.capacity_bytes,
    requests: ["GET /checkout/v1/offers", "OPTIONS /checkout/v1/orders"],
    paymentAttempted: false, livePaymentAccepted: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await runPreflight(options);
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write("Checkout preflight passed. Private evidence saved; no payment attempted.\n");
  } catch (error) {
    // Transport/filesystem errors can contain private endpoints and paths.
    const reason = error instanceof PreflightError ? error.message : "Check TLS, connectivity and a writable, unused output path.";
    process.stderr.write(`Checkout preflight failed: ${reason} No payment attempted.\n`);
    process.exitCode = 1;
  }
}
