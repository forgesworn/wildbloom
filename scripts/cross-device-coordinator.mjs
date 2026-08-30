import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { extname, dirname, resolve } from "node:path";
import TrackerServer from "bittorrent-tracker/server";
import { validateEvent, verifyEvent } from "nostr-tools/pure";
import { WebSocketServer } from "ws";
import { SECURITY_HEADERS } from "./http-security.mjs";
import { isProductionAssetPath, loadProductionBuild } from "./production-build.mjs";

const LOOPBACK = "127.0.0.1";
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_RELAY_MESSAGE_BYTES = 1024 * 1024;
const ENCRYPTED_MIME_TYPES = new Set([
  "application/vnd.forgesworn.encrypted",
  "application/vnd.wildbloom.encrypted",
]);
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

function parseArguments(argv) {
  const values = { port: "8787" };
  const allowed = new Set(["--public-origin", "--port", "--evidence"]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) throw new Error(`Unknown coordinator argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`${argument} may be supplied only once.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    seen.add(argument);
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (!values["public-origin"] || !values.evidence) {
    throw new Error("Usage: --public-origin https://host[:port] --evidence path [--port 8787]");
  }
  if (!/^[0-9]{1,5}$/u.test(values.port)) throw new Error("Coordinator port must be between 1 and 65535.");
  const port = Number(values.port);
  if (port < 1 || port > 65_535) throw new Error("Coordinator port must be between 1 and 65535.");
  const publicOrigin = new URL(values["public-origin"]);
  if (
    publicOrigin.protocol !== "https:"
    || isIP(publicOrigin.hostname) !== 0
    || publicOrigin.username
    || publicOrigin.password
    || publicOrigin.pathname !== "/"
    || publicOrigin.search
    || publicOrigin.hash
  ) {
    throw new Error("The public origin must be an HTTPS origin without credentials, path, query or fragment.");
  }
  return { port, publicOrigin, evidencePath: resolve(values.evidence) };
}

function sourceState() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("Could not identify the exact source commit.");
  if (status !== "") throw new Error("Cross-device evidence must start from a clean worktree.");
  return { commit, clean: true };
}

function fixtureBytes() {
  const block = Buffer.from("Wildbloom public cross-device acceptance fixture\n", "utf8");
  const chunks = [];
  let size = 0;
  while (size < 512 * 1024) {
    const remaining = 512 * 1024 - size;
    const chunk = block.subarray(0, Math.min(block.length, remaining));
    chunks.push(chunk);
    size += chunk.length;
  }
  return Buffer.concat(chunks);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactTag(event, name, maximumLength = 16_384) {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length !== 1 || matches[0].length !== 2 || typeof matches[0][1] !== "string") {
    throw new Error(`Event ${event.id} does not contain one exact ${name} tag.`);
  }
  if (matches[0][1].length === 0 || matches[0][1].length > maximumLength) {
    throw new Error(`Event ${event.id} has an invalid ${name} tag.`);
  }
  return matches[0][1];
}

function eventFacts(event, endpointId, publicOrigin) {
  if (!validateEvent(event) || !verifyEvent(event)) throw new Error("Relay received an event with an invalid signature.");
  if (event.kind !== 1063 && event.kind !== 2003) throw new Error("Controlled relay accepts only kinds 1063 and 2003.");
  if (event.content.length > 4096 || event.tags.length > 64) throw new Error("Relay event exceeds Wildbloom's bounds.");
  if (event.tags.some((tag) => !Array.isArray(tag) || tag.length > 8 || tag.some((value) => typeof value !== "string"))) {
    throw new Error("Relay event contains an invalid tag.");
  }
  if (event.kind === 1063) {
    const blobHash = exactTag(event, "x", 64);
    const originalHash = exactTag(event, "ox", 64);
    const infoHash = exactTag(event, "i", 40);
    const url = new URL(exactTag(event, "url", 2048));
    if (!/^[0-9a-f]{64}$/u.test(blobHash) || originalHash !== blobHash) throw new Error("NIP-94 envelope hashes are invalid.");
    if (!/^[0-9a-f]{40}$/u.test(infoHash)) throw new Error("NIP-94 torrent info hash is invalid.");
    if (url.origin !== publicOrigin.origin || url.pathname !== `/${blobHash}.wbenc` || url.search || url.hash) {
      throw new Error("NIP-94 Blossom URL does not identify this controlled origin and blob.");
    }
    return { id: event.id, kind: event.kind, pubkey: event.pubkey, endpointId, blobHash, infoHash };
  }
  const infoHash = exactTag(event, "x", 40);
  if (!/^[0-9a-f]{40}$/u.test(infoHash)) throw new Error("NIP-35 torrent info hash is invalid.");
  return { id: event.id, kind: event.kind, pubkey: event.pubkey, endpointId, infoHash };
}

function decodeAuthorisation(header, expectedHash, expectedHostname) {
  if (typeof header !== "string" || !header.startsWith("Nostr ") || header.length > 16 * 1024) {
    throw new Error("Blossom upload omitted a bounded Nostr authorisation.");
  }
  let event;
  try {
    const encoded = header.slice("Nostr ".length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) throw new Error("invalid base64");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("non-canonical base64");
    event = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Blossom upload authorisation is not canonical base64 JSON.");
  }
  if (!validateEvent(event) || !verifyEvent(event) || event.kind !== 24242) {
    throw new Error("Blossom upload authorisation has an invalid signature or kind.");
  }
  const tags = event.tags;
  if (
    tags.length !== 4
    || JSON.stringify(tags[0]) !== JSON.stringify(["t", "upload"])
    || JSON.stringify(tags[2]) !== JSON.stringify(["server", expectedHostname])
    || JSON.stringify(tags[3]) !== JSON.stringify(["x", expectedHash])
    || tags[1]?.length !== 2
    || tags[1][0] !== "expiration"
    || !/^[0-9]{1,16}$/u.test(tags[1][1] ?? "")
  ) {
    throw new Error("Blossom upload authorisation is not scoped to the exact host and blob.");
  }
  const expiration = Number(tags[1][1]);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(event.created_at)
    || event.created_at >= now
    || expiration <= now
    || expiration - event.created_at < 30
    || expiration - event.created_at > 300
    || event.content !== `Upload blob ${expectedHash} to ${expectedHostname}`
  ) {
    throw new Error("Blossom upload authorisation is not exact and short-lived.");
  }
  return {
    eventId: event.id,
    pubkey: event.pubkey,
    lifetimeSeconds: expiration - event.created_at,
    exactHostAndHash: true,
    signatureValid: true,
  };
}

function ensureEvidenceTarget(path) {
  if (existsSync(path)) throw new Error(`Refusing to overwrite existing evidence: ${path}`);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const details = lstatSync(parent);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Evidence parent must be a real directory.");
}

const options = parseArguments(process.argv.slice(2));
ensureEvidenceTarget(options.evidencePath);
const productionFiles = new Map(loadProductionBuild().map((file) => [file.path, file]));
const source = sourceState();
const fixture = fixtureBytes();
const fixtureHash = sha256(fixture);
const fixtureToken = randomBytes(24).toString("base64url");
const fixturePath = `/__wildbloom/fixture/${fixtureToken}.bin`;
const endpointSalt = randomBytes(32);
const events = new Map();
const sockets = new Set();

const evidence = {
  schema: "wildbloom-cross-device-service-evidence-v1",
  sessionId: randomUUID(),
  status: "incomplete",
  startedAt: new Date().toISOString(),
  endedAt: null,
  source,
  publicOrigin: options.publicOrigin.origin,
  fixture: { sha256: fixtureHash, size: fixture.length, fetchEndpointIds: [] },
  blossom: { uploads: [], retrievalAttempts: 0, bytesServed: 0 },
  relay: { publications: [], lookups: [] },
  tracker: { swarms: {} },
  errors: [],
};

function persistEvidence() {
  const temporary = `${options.evidencePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, options.evidencePath);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function recordError(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Cross-device coordinator error: ${message.slice(0, 500)}\n`);
  evidence.errors.push("A controlled service reported an error; see the private coordinator console.");
  persistEvidence();
}

function requestAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || forwarded.includes(",") || forwarded.length > 64) {
    throw new Error("The TLS proxy did not supply one exact client address.");
  }
  const address = forwarded.startsWith("[") && forwarded.endsWith("]") ? forwarded.slice(1, -1) : forwarded;
  if (isIP(address) === 0) throw new Error("The TLS proxy supplied an invalid client address.");
  return address;
}

function endpointId(request) {
  return `endpoint-${createHash("sha256").update(endpointSalt).update(requestAddress(request)).digest("hex").slice(0, 16)}`;
}

function hostAllowed(request) {
  return request.headers.host?.toLowerCase() === options.publicOrigin.host.toLowerCase();
}

function respond(response, status, headers, body = "") {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Length": String(bytes.length),
    ...headers,
  });
  response.end(response.req.method === "HEAD" ? undefined : bytes);
}

function hasRequestBody(request) {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const contentLength = request.headers["content-length"];
  return contentLength !== undefined && contentLength !== "0";
}

function readRequestBody(request, maximumBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(new Error("Controlled upload exceeded its acceptance cap."));
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once("end", () => resolveBody(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function trackerSwarm(infoHash) {
  evidence.tracker.swarms[infoHash] ??= {
    endpointIds: [],
    announcementCounts: { started: 0, stopped: 0, completed: 0, update: 0 },
    peakConcurrentEndpoints: 0,
    currentEndpointIds: [],
  };
  return evidence.tracker.swarms[infoHash];
}

function updateTrackerEvidence(socketState, raw) {
  if (raw.length > MAX_RELAY_MESSAGE_BYTES) throw new Error("Tracker message exceeded the acceptance cap.");
  const message = JSON.parse(raw.toString("utf8"));
  if (typeof message.info_hash !== "string" || message.info_hash.length !== 20 || typeof message.peer_id !== "string") return;
  const infoHash = Buffer.from(message.info_hash, "binary").toString("hex");
  if (!/^[0-9a-f]{40}$/u.test(infoHash)) throw new Error("Tracker received an invalid info hash.");
  const peerId = sha256(Buffer.from(message.peer_id, "binary")).slice(0, 16);
  const key = `${infoHash}:${peerId}`;
  const action = message.event === "started"
    ? "started"
    : message.event === "stopped"
      ? "stopped"
      : message.event === "completed"
        ? "completed"
        : "update";
  const swarm = trackerSwarm(infoHash);
  if (!swarm.endpointIds.includes(socketState.endpointId)) swarm.endpointIds.push(socketState.endpointId);
  swarm.announcementCounts[action] += 1;
  if (action === "stopped") socketState.peers.delete(key);
  else socketState.peers.set(key, infoHash);
  const active = new Set();
  for (const state of socketStates) {
    for (const activeInfoHash of state.peers.values()) {
      if (activeInfoHash === infoHash) active.add(state.endpointId);
    }
  }
  swarm.currentEndpointIds = [...active].sort();
  swarm.peakConcurrentEndpoints = Math.max(swarm.peakConcurrentEndpoints, active.size);
  persistEvidence();
}

function removeTrackerSocket(socketState) {
  const affected = new Set(socketState.peers.values());
  socketState.peers.clear();
  socketStates.delete(socketState);
  for (const infoHash of affected) {
    const swarm = trackerSwarm(infoHash);
    const active = new Set();
    for (const state of socketStates) {
      for (const activeInfoHash of state.peers.values()) {
        if (activeInfoHash === infoHash) active.add(state.endpointId);
      }
    }
    swarm.currentEndpointIds = [...active].sort();
  }
  persistEvidence();
}

const tracker = new TrackerServer({ http: false, udp: false, ws: { noServer: true }, stats: false, interval: 30_000 });
const socketStates = new Set();
tracker.on("error", recordError);
tracker.on("warning", recordError);

const relay = new WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_MESSAGE_BYTES });
relay.on("error", recordError);
relay.on("connection", (socket, request) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  let requester;
  try {
    requester = endpointId(request);
  } catch (error) {
    recordError(error);
    socket.close(1008, "Invalid proxy identity");
    return;
  }
  socket.on("message", (raw) => {
    try {
      if (raw.length > MAX_RELAY_MESSAGE_BYTES) throw new Error("Relay message exceeded the acceptance cap.");
      const message = JSON.parse(raw.toString("utf8"));
      if (!Array.isArray(message) || typeof message[0] !== "string") throw new Error("Relay received invalid JSON.");
      if (message[0] === "EVENT") {
        const facts = eventFacts(message[1], requester, options.publicOrigin);
        events.set(facts.id, message[1]);
        evidence.relay.publications.push(facts);
        persistEvidence();
        socket.send(JSON.stringify(["OK", facts.id, true, "stored by controlled relay"]));
        return;
      }
      if (message[0] === "REQ") {
        const subscription = message[1];
        const filter = message[2];
        if (
          message.length !== 3
          || typeof subscription !== "string"
          || subscription.length > 64
          || !filter
          || typeof filter !== "object"
          || Object.keys(filter).length !== 1
          || !Array.isArray(filter.ids)
          || filter.ids.length !== 1
          || typeof filter.ids[0] !== "string"
        ) {
          throw new Error("Controlled relay accepts only one exact-ID lookup.");
        }
        const requestedId = filter.ids[0];
        evidence.relay.lookups.push({ eventId: requestedId, endpointId: requester, exactId: true });
        persistEvidence();
        const event = events.get(requestedId);
        if (event) socket.send(JSON.stringify(["EVENT", subscription, event]));
        socket.send(JSON.stringify(["EOSE", subscription]));
        return;
      }
      if (message[0] !== "CLOSE") throw new Error("Controlled relay received an unsupported command.");
    } catch (error) {
      recordError(error);
      socket.close(1008, "Controlled relay rejected the message");
    }
  });
});

const server = createServer({
  connectionsCheckingInterval: 1_000,
  headersTimeout: 10_000,
  insecureHTTPParser: false,
  keepAliveTimeout: 5_000,
  maxHeaderSize: 16_384,
  rejectNonStandardBodyWrites: true,
  requestTimeout: 30_000,
  requireHostHeader: true,
}, (request, response) => {
  void (async () => {
    if (!hostAllowed(request)) {
      request.resume();
      respond(response, 421, { "Content-Type": "text/plain; charset=utf-8" }, "Misdirected request\n");
      return;
    }
    const target = request.url ?? "";
    if (
      !target.startsWith("/")
      || target.startsWith("//")
      || target.includes("\\")
      || target.includes("%")
      || target.includes("?")
      || target.includes("#")
      || target.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      request.resume();
      respond(response, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request\n");
      return;
    }
    const url = new URL(target, options.publicOrigin);
    if (url.origin !== options.publicOrigin.origin || url.search || url.hash) throw new Error("Request target changed origin.");
    const isUpload = request.method === "PUT" && url.pathname === "/upload";
    if (!isUpload && hasRequestBody(request)) {
      request.resume();
      respond(response, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request\n");
      return;
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/healthz") {
      respond(response, 200, { "Content-Type": "application/json; charset=utf-8" }, '{"status":"ok"}\n');
      return;
    }
    if (request.method === "GET" && url.pathname === fixturePath) {
      const requester = endpointId(request);
      if (!evidence.fixture.fetchEndpointIds.includes(requester)) evidence.fixture.fetchEndpointIds.push(requester);
      persistEvidence();
      respond(response, 200, { "Content-Type": "application/octet-stream" }, fixture);
      return;
    }
    if (isUpload) {
      const requester = endpointId(request);
      const body = await readRequestBody(request, MAX_UPLOAD_BYTES);
      if (body.length === 0) throw new Error("Browser upload omitted its request body.");
      if (body.includes(fixture)) throw new Error("Browser upload exposed plaintext fixture bytes.");
      const hash = sha256(body);
      if (request.headers["x-sha-256"] !== hash) throw new Error("Browser upload sent the wrong X-SHA-256.");
      const mimeType = request.headers["content-type"]?.toLowerCase();
      if (!mimeType || !ENCRYPTED_MIME_TYPES.has(mimeType)) throw new Error("Browser upload exposed a non-encrypted MIME type.");
      const authorisation = decodeAuthorisation(request.headers.authorization, hash, options.publicOrigin.hostname);
      const upload = {
        endpointId: requester,
        sha256: hash,
        size: body.length,
        mimeType,
        sourceBytesExposed: false,
        authorisation,
      };
      evidence.blossom.uploads.push(upload);
      persistEvidence();
      respond(response, 201, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify({
        url: `${options.publicOrigin.origin}/${hash}.wbenc`,
        sha256: hash,
        size: body.length,
        type: mimeType,
        uploaded: Math.floor(Date.now() / 1000),
      }));
      return;
    }
    const blobMatch = /^\/([0-9a-f]{64})\.wbenc$/u.exec(url.pathname);
    if (request.method === "GET" && blobMatch) {
      evidence.blossom.retrievalAttempts += 1;
      persistEvidence();
      respond(response, 503, { "Content-Type": "text/plain; charset=utf-8" }, "Web seed deliberately unavailable during cross-device acceptance\n");
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (relative === "index.html" || isProductionAssetPath(relative)) {
        const file = productionFiles.get(relative);
        if (file) {
          response.writeHead(200, {
            ...SECURITY_HEADERS,
            "Cache-Control": relative === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
            "Content-Length": String(file.bytes),
            "Content-Type": CONTENT_TYPES.get(extname(relative)) ?? "application/octet-stream",
          });
          response.end(request.method === "HEAD" ? undefined : file.content);
          return;
        }
      }
    }
    request.resume();
    if (request.method !== "GET" && request.method !== "HEAD") {
      respond(response, 405, { Allow: "GET, HEAD, PUT", "Content-Type": "text/plain; charset=utf-8" }, "Method not allowed\n");
    } else {
      respond(response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found\n");
    }
  })().catch((error) => {
    recordError(error);
    if (!response.headersSent) respond(response, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Controlled service failure\n");
    else response.destroy();
  });
});

server.on("upgrade", (request, socket, head) => {
  try {
    if (!hostAllowed(request)) throw new Error("WebSocket upgrade used an unexpected Host.");
    const url = new URL(request.url ?? "/", options.publicOrigin);
    if (url.pathname === "/relay" && !url.search && !url.hash) {
      relay.handleUpgrade(request, socket, head, (websocket) => relay.emit("connection", websocket, request));
      return;
    }
    if (url.pathname === "/announce" && !url.search && !url.hash) {
      const state = { endpointId: endpointId(request), peers: new Map() };
      tracker.ws.handleUpgrade(request, socket, head, (websocket) => {
        sockets.add(websocket);
        socketStates.add(state);
        websocket.on("message", (raw) => {
          try {
            updateTrackerEvidence(state, raw);
          } catch (error) {
            recordError(error);
            websocket.close(1008, "Controlled tracker rejected the message");
          }
        });
        websocket.once("close", () => {
          sockets.delete(websocket);
          removeTrackerSocket(state);
        });
        tracker.ws.emit("connection", websocket, request);
      });
      return;
    }
    throw new Error("Unknown WebSocket path.");
  } catch (error) {
    recordError(error);
    socket.destroy();
  }
});

server.on("clientError", (error, socket) => {
  recordError(error);
  socket.destroy();
});

persistEvidence();
server.listen(options.port, LOOPBACK, () => {
  process.stdout.write([
    `Wildbloom cross-device coordinator listening on http://${LOOPBACK}:${options.port}`,
    `Open on both devices: ${options.publicOrigin.origin}/`,
    `Publisher fixture: ${options.publicOrigin.origin}${fixturePath}`,
    `Blossom: ${options.publicOrigin.origin}`,
    `Relay: ${options.publicOrigin.origin.replace(/^https:/u, "wss:")}/relay`,
    `Tracker: ${options.publicOrigin.origin.replace(/^https:/u, "wss:")}/announce`,
    `Redacted service evidence: ${options.evidencePath}`,
    "",
  ].join("\n"));
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (Object.values(evidence.tracker.swarms).some((swarm) => swarm.currentEndpointIds.length > 0)) {
    evidence.errors.push("One or more peers remained active when coordinator shutdown began.");
  }
  for (const socket of sockets) socket.close(1001, "Coordinator stopping");
  await new Promise((resolveClose) => server.close(resolveClose));
  await new Promise((resolveClose) => tracker.close(resolveClose));
  evidence.status = "closed";
  evidence.endedAt = new Date().toISOString();
  persistEvidence();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stop().then(() => process.exit(0), (error) => {
      recordError(error);
      process.exit(1);
    });
  });
}
