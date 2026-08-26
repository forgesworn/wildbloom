import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { inspectProductionBuild } from "./production-build.mjs";
import { collectReleaseEvidence } from "./release-evidence.mjs";

const HOST = "127.0.0.1";

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const reservation = createServer();
    reservation.once("error", reject);
    reservation.listen(0, HOST, () => {
      const address = reservation.address();
      if (!address || typeof address === "string") {
        reservation.close();
        reject(new Error("Could not reserve a production port."));
        return;
      }
      reservation.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function exchange(port, { method = "GET", path = "/", host = "wildbloom.test", body } = {}) {
  return new Promise((resolveResponse, reject) => {
    const call = request({ hostname: HOST, port, method, path, headers: { Host: host } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolveResponse({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    call.once("error", reject);
    if (body) call.write(body);
    call.end();
  });
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectRejectedBuild(mutate, expected) {
  const temporary = mkdtempSync(join(tmpdir(), "wildbloom-build-boundary-"));
  const build = join(temporary, "dist");
  try {
    cpSync(resolve("dist"), build, { recursive: true });
    mutate(build);
    let message = "";
    try {
      inspectProductionBuild(build);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.includes(expected), `Release evidence accepted a malformed build; expected ${JSON.stringify(expected)}, received ${JSON.stringify(message)}.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function expectReleaseEvidenceCli(evidence) {
  const temporary = mkdtempSync(join(tmpdir(), "wildbloom-release-evidence-"));
  const output = join(temporary, "evidence.json");
  try {
    const written = spawnSync(process.execPath, ["scripts/release-evidence.mjs", "--output", output], { encoding: "utf8" });
    expect(written.status === 0, `Release-evidence output failed: ${written.stderr}`);
    const parsed = JSON.parse(readFileSync(output, "utf8"));
    expect(parsed.buildSha256 === evidence.buildSha256, "Written release evidence did not describe the inspected build.");
    expect(parsed.sourceCommit === evidence.sourceCommit, "Written release evidence did not describe the current source commit.");

    const overwrite = spawnSync(process.execPath, ["scripts/release-evidence.mjs", "--output", output], { encoding: "utf8" });
    expect(overwrite.status !== 0 && overwrite.stderr.includes("EEXIST"), "Release evidence silently overwrote an existing record.");
    const misspelt = spawnSync(process.execPath, ["scripts/release-evidence.mjs", "--require-cleen"], { encoding: "utf8" });
    expect(misspelt.status !== 0 && misspelt.stderr.includes("Unknown release-evidence argument"), "Release evidence ignored an unknown safety argument.");
    const publicOutput = spawnSync(process.execPath, ["scripts/release-evidence.mjs", "--output", "dist/evidence.json"], { encoding: "utf8" });
    expect(publicOutput.status !== 0 && publicOutput.stderr.includes("public build directory"), "Release evidence could be written into the public build.");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function expectSecurityHeaders(response, label) {
  const csp = response.headers["content-security-policy"] ?? "";
  for (const directive of [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "connect-src 'self' https: wss:",
  ]) {
    expect(csp.includes(directive), `${label} omitted CSP directive: ${directive}`);
  }
  expect(!csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'"), `${label} weakened script/style execution policy.`);
  expect(response.headers["cross-origin-opener-policy"] === "same-origin", `${label} omitted the opener boundary.`);
  expect(response.headers["cross-origin-resource-policy"] === "same-origin", `${label} omitted the resource boundary.`);
  expect(response.headers["referrer-policy"] === "no-referrer", `${label} could leak referrers.`);
  expect(response.headers["x-content-type-options"] === "nosniff", `${label} permitted MIME sniffing.`);
  expect(response.headers["x-frame-options"] === "DENY", `${label} permitted framing.`);
  const permissions = response.headers["permissions-policy"] ?? "";
  for (const feature of ["camera=()", "geolocation=()", "microphone=()", "payment=()", "usb=()"]) {
    expect(permissions.includes(feature), `${label} did not disable ${feature}.`);
  }
}

async function waitForServer(server, port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Production server exited early with ${server.exitCode}.`);
    try {
      const response = await exchange(port, { path: "/healthz" });
      if (response.status === 200) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Timed out waiting for the production server.");
}

function stopChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

const evidence = collectReleaseEvidence();
expectReleaseEvidenceCli(evidence);
expectRejectedBuild(
  (build) => writeFileSync(join(build, "assets", "source.js.map"), "private source"),
  "not a hashed JavaScript or CSS file",
);
expectRejectedBuild(
  (build) => writeFileSync(join(build, "operator-notes.txt"), "must not be published"),
  "unexpected root entries",
);
const port = await availablePort();
const production = spawn(process.execPath, ["scripts/serve-production.mjs", "--host", HOST, "--port", String(port)], {
  env: { ...process.env, WILDBLOOM_ALLOWED_HOSTS: `wildbloom.test,${HOST}` },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForServer(production, port);

  const health = await exchange(port, { path: "/healthz" });
  expect(health.status === 200, "Health endpoint was not ready.");
  expect(health.body.equals(Buffer.from('{"status":"ok"}\n')), "Health endpoint returned unexpected bytes.");
  expect(health.headers["cache-control"] === "no-store", "Health response was cacheable.");
  expectSecurityHeaders(health, "Health response");

  const index = await exchange(port);
  const expectedIndex = readFileSync(resolve("dist/index.html"));
  expect(index.status === 200 && index.body.equals(expectedIndex), "Production root did not return exact built index bytes.");
  expect(index.headers["cache-control"] === "no-store", "Production HTML was cacheable.");
  expect(index.headers["content-length"] === String(expectedIndex.length), "Production HTML length was not exact.");
  expect(index.headers["content-type"] === "text/html; charset=utf-8", "Production HTML MIME type was not exact.");
  expectSecurityHeaders(index, "Production HTML");

  const indexHead = await exchange(port, { method: "HEAD" });
  expect(indexHead.status === 200 && indexHead.body.length === 0, "HEAD returned HTML response bytes.");
  expect(indexHead.headers["content-length"] === String(expectedIndex.length), "HEAD did not report the exact HTML length.");

  for (const file of evidence.files.filter((item) => item.path !== "index.html")) {
    const response = await exchange(port, { path: `/${file.path}?release-probe=1` });
    expect(response.status === 200, `Hashed asset was not served: ${file.path}`);
    expect(response.headers["cache-control"] === "public, max-age=31536000, immutable", `Hashed asset was not immutable: ${file.path}`);
    expect(response.headers["content-length"] === String(file.bytes), `Hashed asset length drifted: ${file.path}`);
    expect(createHash("sha256").update(response.body).digest("hex") === file.sha256, `Served asset hash drifted: ${file.path}`);
    expectSecurityHeaders(response, `Hashed asset ${file.path}`);
    const head = await exchange(port, { method: "HEAD", path: `/${file.path}` });
    expect(head.status === 200 && head.body.length === 0, `HEAD returned asset bytes: ${file.path}`);
    expect(head.headers["content-length"] === String(file.bytes), `HEAD asset length drifted: ${file.path}`);
  }

  const rejected = [
    { path: "/package.json", status: 404, label: "repository file" },
    { path: "/.git/config", status: 404, label: "Git metadata" },
    { path: "/assets/unhashed.js", status: 404, label: "unhashed asset" },
    { path: "/assets/source.js.map", status: 404, label: "source map" },
    { path: "/assets/%2e%2e/index.html", status: 400, label: "encoded traversal" },
    { path: "/assets/%5c..%5cindex.html", status: 400, label: "encoded backslash traversal" },
    { path: "/bad%zz", status: 400, label: "malformed encoding" },
    { path: "http://attacker.invalid/", status: 400, label: "absolute-form target" },
  ];
  for (const probe of rejected) {
    const response = await exchange(port, { path: probe.path });
    expect(response.status === probe.status, `Production server accepted ${probe.label}; received ${response.status}.`);
    expect(response.headers["cache-control"] === "no-store", `Rejected ${probe.label} response was cacheable.`);
    expectSecurityHeaders(response, `Rejected ${probe.label}`);
  }

  const badHost = await exchange(port, { host: "attacker.invalid" });
  expect(badHost.status === 421, "Production server accepted an undeclared Host authority.");
  for (const deceptiveHost of ["attacker@wildbloom.test", "wildbloom.test/path", "wildbloom.test?ignored"]) {
    const deceptive = await exchange(port, { host: deceptiveHost });
    expect(deceptive.status === 421, `Production server accepted a deceptive Host authority: ${deceptiveHost}`);
  }
  const post = await exchange(port, { method: "POST", path: "/healthz", body: "not accepted" });
  expect(post.status === 405 && post.headers.allow === "GET, HEAD", "Production server accepted a request body or omitted its method boundary.");

  process.stdout.write(
    `Deployment acceptance passed: ${evidence.files.length} exact built files (${evidence.buildSha256}), strict immutable hashes, no-store HTML/health/errors, security headers and hostile host/method/path rejection.\n`,
  );
} finally {
  await stopChild(production);
}
