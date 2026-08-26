import { createReadStream, lstatSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { SECURITY_HEADERS } from "./http-security.mjs";
import { inspectProductionBuild, isProductionAssetPath } from "./production-build.mjs";

const args = process.argv.slice(2);
function argumentsFrom(argv) {
  const values = { host: "127.0.0.1", port: "8080" };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--host" && argument !== "--port") {
      throw new Error("Unknown production-server argument.");
    }
    if (seen.has(argument)) throw new Error(`${argument} may be supplied only once.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    seen.add(argument);
    values[argument.slice(2)] = value;
    index += 1;
  }
  return values;
}

const options = argumentsFrom(args);
const host = options.host;
if (host.length > 253 || /[\s/?#@\\]/u.test(host)) throw new Error("Production bind host is invalid.");
if (!/^[0-9]{1,5}$/u.test(options.port)) throw new Error("Production port must be between 1 and 65535.");
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Production port must be between 1 and 65535.");
const root = resolve(process.cwd(), "dist");
inspectProductionBuild(root);

function normaliseAllowedHost(value) {
  const raw = value.trim().toLowerCase();
  if (!raw || /[\s/?#@\\]/u.test(raw)) throw new Error("Production Host allowlist contains an invalid hostname.");
  const authority = raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
  let parsed;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    throw new Error("Production Host allowlist contains an invalid hostname.");
  }
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Production Host allowlist accepts hostnames only, without ports or URL syntax.");
  }
  return parsed.hostname.toLowerCase();
}

const allowedHosts = new Set((process.env.WILDBLOOM_ALLOWED_HOSTS ?? `localhost,127.0.0.1,${host}`)
  .split(",").map(normaliseAllowedHost));
if (allowedHosts.size === 0) throw new Error("Production Host allowlist must name at least one hostname.");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

function hostAllowed(request) {
  const authority = request.headers.host;
  if (!authority) return false;
  try {
    const parsed = new URL(`http://${authority}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
    return allowedHosts.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function respond(response, status, headers, body = "") {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(response.req.method === "HEAD" ? undefined : body);
}

function hasRequestBody(request) {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const contentLength = request.headers["content-length"];
  return contentLength !== undefined && contentLength !== "0";
}

const server = createServer({
  connectionsCheckingInterval: 1_000,
  headersTimeout: 10_000,
  insecureHTTPParser: false,
  keepAliveTimeout: 5_000,
  maxHeaderSize: 16_384,
  rejectNonStandardBodyWrites: true,
  requestTimeout: 10_000,
  requireHostHeader: true,
}, (request, response) => {
  if (!hostAllowed(request)) {
    respond(response, 421, { "Content-Type": "text/plain; charset=utf-8" }, "Misdirected request\n");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    request.resume();
    respond(response, 405, { Allow: "GET, HEAD", Connection: "close", "Content-Type": "text/plain; charset=utf-8" }, "Method not allowed\n");
    return;
  }
  if (hasRequestBody(request)) {
    request.resume();
    respond(response, 400, { Connection: "close", "Content-Type": "text/plain; charset=utf-8" }, "Bad request\n");
    return;
  }
  const target = request.url ?? "";
  const rawPath = target;
  if (
    !target.startsWith("/")
    || target.startsWith("//")
    || rawPath.includes("\\")
    || rawPath.includes("%")
    || target.includes("?")
    || target.includes("#")
    || rawPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    respond(response, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request\n");
    return;
  }
  let url;
  try {
    url = new URL(target, "http://localhost");
  } catch {
    respond(response, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request\n");
    return;
  }
  if (url.pathname === "/healthz") {
    respond(response, 200, { "Content-Type": "application/json; charset=utf-8" }, '{"status":"ok"}\n');
    return;
  }

  let relative;
  try {
    relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  } catch {
    respond(response, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request\n");
    return;
  }
  if (relative !== "index.html" && !isProductionAssetPath(relative)) {
    respond(response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found\n");
    return;
  }
  const file = resolve(root, relative);
  let details;
  try {
    details = lstatSync(file);
  } catch {
    respond(response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found\n");
    return;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    respond(response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found\n");
    return;
  }
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Cache-Control": relative === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
    "Content-Length": String(details.size),
    "Content-Type": contentTypes.get(extname(file)) ?? "application/octet-stream",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
});

server.on("checkContinue", (request, response) => {
  request.resume();
  respond(response, 417, { Connection: "close", "Content-Type": "text/plain; charset=utf-8" }, "Expectation failed\n");
});
server.on("checkExpectation", (request, response) => {
  request.resume();
  respond(response, 417, { Connection: "close", "Content-Type": "text/plain; charset=utf-8" }, "Expectation failed\n");
});
const parserErrorBody = "Bad request\n";
const parserErrorResponse = [
  "HTTP/1.1 400 Bad Request",
  ...Object.entries({
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Length": String(Buffer.byteLength(parserErrorBody)),
    "Content-Type": "text/plain; charset=utf-8",
  }).map(([name, value]) => `${name}: ${value}`),
  "",
  parserErrorBody,
].join("\r\n");
server.on("clientError", (_error, socket) => {
  if (socket.destroyed || socket.writableEnded) return;
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(parserErrorResponse);
});

server.listen(port, host, () => process.stdout.write(`Wildbloom production server listening on http://${host}:${port}\n`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
