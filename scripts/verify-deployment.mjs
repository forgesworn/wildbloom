import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { SECURITY_HEADERS } from "./http-security.mjs";
import { privateRecordOutput } from "./private-record.mjs";
import { isProductionAssetPath } from "./production-build.mjs";

const HEX_64 = /^[0-9a-f]{64}$/u;
const HEX_40 = /^[0-9a-f]{40}$/u;
const V3_ONION = /^([a-z2-7]{56})\.onion$/u;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ONION_CHECKSUM_PREFIX = new TextEncoder().encode(".onion checksum");
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_RELEASE_FILES = 64;
const MAX_RELEASE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RELEASE_BUILD_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function objectKeys(value) {
  return Object.keys(value).sort().join(",");
}

function decodeBase32(value) {
  let bits = 0;
  let accumulator = 0;
  const output = [];
  for (const character of value) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("Deployment origin has an invalid v3 onion address.");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits !== 0 || output.length !== 35) throw new Error("Deployment origin has an invalid v3 onion address.");
  return new Uint8Array(output);
}

function assertV3Onion(hostname) {
  const match = V3_ONION.exec(hostname.toLowerCase());
  if (!match?.[1]) throw new Error("HTTP deployment verification accepts exact v3 onion origins only.");
  const decoded = decodeBase32(match[1]);
  const publicKey = decoded.subarray(0, 32);
  const checksum = decoded.subarray(32, 34);
  const version = decoded[34];
  expect(version === 3, "Deployment origin has an invalid v3 onion service version.");
  const checksumInput = new Uint8Array(ONION_CHECKSUM_PREFIX.length + publicKey.length + 1);
  checksumInput.set(ONION_CHECKSUM_PREFIX);
  checksumInput.set(publicKey, ONION_CHECKSUM_PREFIX.length);
  checksumInput[checksumInput.length - 1] = version;
  const expected = sha3_256(checksumInput).subarray(0, 2);
  expect(
    checksum[0] === expected[0] && checksum[1] === expected[1],
    "Deployment origin has an invalid v3 onion service checksum.",
  );
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normaliseDeploymentOrigin(value, { allowLoopback = false } = {}) {
  const origin = new URL(String(value).trim());
  expect(!origin.username && !origin.password, "Deployment origin must not contain credentials.");
  expect(origin.pathname === "/" && !origin.search && !origin.hash, "Deployment origin must not contain a path, query or fragment.");
  if (origin.protocol === "https:") {
    expect(!origin.hostname.endsWith(".onion"), "Verify onion services over their HTTP onion origin.");
  } else if (origin.protocol === "http:" && origin.hostname.endsWith(".onion")) {
    assertV3Onion(origin.hostname);
  } else if (!(allowLoopback && origin.protocol === "http:" && isLoopback(origin.hostname))) {
    throw new Error("Deployment verification requires HTTPS, an HTTP v3 onion origin, or explicit loopback testing.");
  }
  return origin.origin;
}

export function validateReleaseEvidence(value) {
  expect(value && typeof value === "object" && !Array.isArray(value), "Release evidence must be a JSON object.");
  expect(
    objectKeys(value) === "buildSha256,buildToolchain,files,format,packageLockSha256,sourceCommit,sourceTreeClean",
    "Release evidence has an unexpected top-level shape.",
  );
  expect(value.format === "wildbloom-release-evidence-v2", "Release evidence has an unsupported format.");
  expect(HEX_40.test(value.sourceCommit), "Release evidence has an invalid source commit.");
  expect(value.sourceTreeClean === true, "Release evidence must attest a clean source tree.");
  expect(HEX_64.test(value.packageLockSha256), "Release evidence has an invalid package-lock hash.");
  expect(
    value.buildToolchain && typeof value.buildToolchain === "object" && !Array.isArray(value.buildToolchain)
      && objectKeys(value.buildToolchain) === "node,npm",
    "Release evidence has an invalid build toolchain shape.",
  );
  expect(/^v24\.[0-9]+\.[0-9]+$/u.test(value.buildToolchain.node), "Release evidence has an unsupported Node build version.");
  expect(/^11\.[0-9]+\.[0-9]+$/u.test(value.buildToolchain.npm), "Release evidence has an unsupported npm build version.");
  expect(HEX_64.test(value.buildSha256), "Release evidence has an invalid aggregate build hash.");
  expect(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= MAX_RELEASE_FILES, "Release evidence has an invalid file list.");

  const paths = new Set();
  let buildBytes = 0;
  for (const file of value.files) {
    expect(file && typeof file === "object" && !Array.isArray(file), "Release evidence contains an invalid file entry.");
    expect(objectKeys(file) === "bytes,path,sha256", "Release evidence file entry has an unexpected shape.");
    expect(file.path === "index.html" || isProductionAssetPath(file.path), `Release evidence contains an unsafe file path: ${String(file.path)}`);
    expect(!paths.has(file.path), `Release evidence contains a duplicate file path: ${file.path}`);
    expect(
      Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_RELEASE_FILE_BYTES,
      `Release evidence has an invalid or excessive byte count: ${file.path}`,
    );
    expect(HEX_64.test(file.sha256), `Release evidence has an invalid file hash: ${file.path}`);
    buildBytes += file.bytes;
    paths.add(file.path);
  }
  expect(buildBytes <= MAX_RELEASE_BUILD_BYTES, "Release evidence exceeds the deployment verification byte budget.");
  expect(paths.has("index.html"), "Release evidence does not contain index.html.");
  expect(
    JSON.stringify(value.files.map((file) => file.path))
      === JSON.stringify([...value.files.map((file) => file.path)].sort()),
    "Release evidence file paths are not canonical.",
  );
  const aggregate = createHash("sha256")
    .update(value.files.map((file) => `${file.sha256}  ${file.bytes}  ${file.path}\n`).join(""))
    .digest("hex");
  expect(aggregate === value.buildSha256, "Release evidence aggregate build hash is inconsistent.");
  return Object.freeze({
    format: value.format,
    sourceCommit: value.sourceCommit,
    sourceTreeClean: value.sourceTreeClean,
    packageLockSha256: value.packageLockSha256,
    buildToolchain: Object.freeze({ ...value.buildToolchain }),
    buildSha256: value.buildSha256,
    files: Object.freeze(value.files.map((file) => Object.freeze({ ...file }))),
  });
}

function readEvidence(path) {
  const absolute = resolve(path);
  const details = lstatSync(absolute);
  expect(details.isFile() && !details.isSymbolicLink(), "Release evidence must be a regular file, not a symbolic link.");
  expect(details.size > 0 && details.size <= MAX_EVIDENCE_BYTES, "Release evidence file has an unsafe size.");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new Error("Release evidence is not valid JSON.");
  }
  return validateReleaseEvidence(parsed);
}

export function assertSecurityHeaders(headers, label) {
  for (const [name, expected] of Object.entries(SECURITY_HEADERS)) {
    expect(headers.get(name) === expected, `${label} changed required ${name}.`);
  }
}

export function assertHsts(headers) {
  const value = headers.get("Strict-Transport-Security") ?? "";
  const maximumAge = /(?:^|;)\s*max-age=([0-9]+)(?:;|$)/iu.exec(value)?.[1];
  expect(maximumAge !== undefined && Number(maximumAge) >= 31_536_000, "HTTPS deployment did not provide at least one year of HSTS.");
}

async function requestExact(url, {
  expectedBytes,
  expectedHash,
  expectedBody,
  expectedCacheControl,
  expectedContentType,
  requireContentLength = true,
  method = "GET",
  label,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`${label} timed out.`, "TimeoutError"));
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: { "Accept-Encoding": "identity", "Cache-Control": "no-cache" },
      redirect: "error",
      signal: controller.signal,
    });
    expect(response.ok, `${label} returned HTTP ${response.status}.`);
    expect(response.url === url, `${label} changed URL unexpectedly.`);
    expect(response.headers.get("Cache-Control") === expectedCacheControl, `${label} has an unexpected cache policy.`);
    expect(response.headers.get("Content-Type") === expectedContentType, `${label} has an unexpected MIME type.`);
    expect(response.headers.get("Content-Encoding") === null, `${label} ignored the identity encoding probe.`);
    const contentLength = response.headers.get("Content-Length");
    if (requireContentLength || contentLength !== null) {
      expect(contentLength === String(expectedBytes), `${label} has an unexpected Content-Length.`);
    }
    assertSecurityHeaders(response.headers, label);
    if (url.startsWith("https://")) assertHsts(response.headers);
    if (method === "HEAD") {
      expect(response.body === null, `${label} returned a body for HEAD.`);
      return { headers: response.headers };
    }
    expect(response.body !== null, `${label} has no readable body.`);
    const reader = response.body.getReader();
    const hasher = createHash("sha256");
    const chunks = expectedBody === undefined ? null : [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > expectedBytes) {
        await reader.cancel("deployment response exceeded release evidence");
        throw new Error(`${label} returned more bytes than release evidence permits.`);
      }
      hasher.update(value);
      chunks?.push(value);
    }
    expect(received === expectedBytes, `${label} returned ${received} bytes instead of ${expectedBytes}.`);
    const hash = hasher.digest("hex");
    if (expectedHash !== undefined) expect(hash === expectedHash, `${label} does not match the release SHA-256.`);
    if (expectedBody !== undefined) {
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      expect(body.equals(expectedBody), `${label} returned unexpected body bytes.`);
    }
    return { headers: response.headers, hash };
  } catch (error) {
    if (timedOut) throw new Error(`${label} timed out.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyDeployment(originInput, evidence, options = {}) {
  const origin = normaliseDeploymentOrigin(originInput, options);
  const validatedEvidence = validateReleaseEvidence(evidence);
  const index = validatedEvidence.files.find((file) => file.path === "index.html");
  expect(index, "Release evidence does not contain index.html.");
  await requestExact(`${origin}/healthz`, {
    expectedBytes: 16,
    expectedBody: Buffer.from('{"status":"ok"}\n'),
    expectedCacheControl: "no-store",
    expectedContentType: "application/json; charset=utf-8",
    requireContentLength: false,
    label: "Deployment health response",
  });

  await requestExact(`${origin}/`, {
    expectedBytes: index.bytes,
    expectedHash: index.sha256,
    expectedCacheControl: "no-store",
    expectedContentType: "text/html; charset=utf-8",
    label: "Deployment index",
  });
  await requestExact(`${origin}/`, {
    expectedBytes: index.bytes,
    expectedCacheControl: "no-store",
    expectedContentType: "text/html; charset=utf-8",
    method: "HEAD",
    label: "Deployment index HEAD",
  });

  for (const file of validatedEvidence.files.filter((item) => item.path !== "index.html")) {
    const contentType = file.path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
    await requestExact(`${origin}/${file.path}`, {
      expectedBytes: file.bytes,
      expectedHash: file.sha256,
      expectedCacheControl: "public, max-age=31536000, immutable",
      expectedContentType: contentType,
      label: `Deployment asset ${file.path}`,
    });
    await requestExact(`${origin}/${file.path}`, {
      expectedBytes: file.bytes,
      expectedCacheControl: "public, max-age=31536000, immutable",
      expectedContentType: contentType,
      method: "HEAD",
      label: `Deployment asset HEAD ${file.path}`,
    });
  }

  return {
    format: "wildbloom-deployment-verification-v2",
    verifiedAt: new Date().toISOString(),
    origin,
    sourceCommit: validatedEvidence.sourceCommit,
    packageLockSha256: validatedEvidence.packageLockSha256,
    buildToolchain: validatedEvidence.buildToolchain,
    buildSha256: validatedEvidence.buildSha256,
    files: validatedEvidence.files,
  };
}

function argumentsFrom(argv) {
  let origin;
  let evidence;
  let output;
  let allowLoopback = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-loopback") {
      expect(!allowLoopback, "--allow-loopback may be supplied only once.");
      allowLoopback = true;
      continue;
    }
    if (["--origin", "--evidence", "--output"].includes(argument)) {
      const value = argv[index + 1];
      expect(value && !value.startsWith("--"), `${argument} requires a value.`);
      if (argument === "--origin") {
        expect(origin === undefined, "--origin may be supplied only once.");
        origin = value;
      } else if (argument === "--evidence") {
        expect(evidence === undefined, "--evidence may be supplied only once.");
        evidence = value;
      } else {
        expect(output === undefined, "--output may be supplied only once.");
        output = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown deployment-verification argument: ${argument}`);
  }
  expect(origin !== undefined, "--origin is required.");
  expect(evidence !== undefined, "--evidence is required.");
  return { origin, evidence, output, allowLoopback };
}

async function run() {
  const options = argumentsFrom(process.argv.slice(2));
  const evidence = readEvidence(options.evidence);
  const output = options.output === undefined
    ? undefined
    : privateRecordOutput(options.output, "Deployment verification");
  const verified = await verifyDeployment(options.origin, evidence, { allowLoopback: options.allowLoopback });
  const payload = `${JSON.stringify(verified, null, 2)}\n`;
  if (options.output === undefined) {
    process.stdout.write(payload);
    return;
  }
  writeFileSync(output, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`Wrote deployment verification to ${output}\n`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === resolve(fileURLToPath(import.meta.url))) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
