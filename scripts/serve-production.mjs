import { createReadStream, lstatSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { SECURITY_HEADERS } from "./http-security.mjs";
import { inspectProductionBuild, isProductionAssetPath } from "./production-build.mjs";

const args = process.argv.slice(2);
function argument(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const host = argument("--host", "127.0.0.1");
const port = Number(argument("--port", "8080"));
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Production port must be between 1 and 65535.");
const root = resolve(process.cwd(), "dist");
inspectProductionBuild(root);
const allowedHosts = new Set((process.env.WILDBLOOM_ALLOWED_HOSTS ?? `localhost,127.0.0.1,${host}`)
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));

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
  response.writeHead(status, { ...SECURITY_HEADERS, "Cache-Control": "no-store", ...headers });
  response.end(body);
}

const server = createServer((request, response) => {
  if (!hostAllowed(request)) {
    respond(response, 421, { "Content-Type": "text/plain; charset=utf-8" }, "Misdirected request\n");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    respond(response, 405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }, "Method not allowed\n");
    return;
  }
  const target = request.url ?? "";
  const rawPath = target.split("?", 1)[0] ?? "";
  if (
    !target.startsWith("/")
    || target.startsWith("//")
    || rawPath.includes("\\")
    || rawPath.includes("%")
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
    respond(response, 200, { "Content-Type": "application/json; charset=utf-8" }, request.method === "HEAD" ? "" : '{"status":"ok"}\n');
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

server.listen(port, host, () => process.stdout.write(`Wildbloom production server listening on http://${host}:${port}\n`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
