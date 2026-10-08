import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HEX = /^[0-9a-f]{64}$/u;
const SCOPE = "full-read retrievability; no continuous-retention or dedicated-copy claim";
class EvidenceError extends Error {}
function requireCheck(condition, message) {
  if (!condition) throw new EvidenceError(message);
}

function exactOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new EvidenceError("Invalid expected node origin."); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  requireCheck(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
    && (url.protocol === "https:" || (url.protocol === "http:" && loopback)), "Use an exact HTTPS or loopback HTTP origin without credentials.");
  return `${url.origin}/`;
}

export function parseArguments(args) {
  const values = {};
  const reports = [];
  const flags = new Set(["--blob", "--sha256", "--size", "--origin", "--output"]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    requireCheck(flag === "--report" || (flags.has(flag) && values[flag] === undefined), "Unknown or duplicate option.");
    requireCheck(args[i + 1] && !args[i + 1].startsWith("--"), "Missing option value.");
    const value = args[++i];
    if (flag === "--report") reports.push(resolve(value));
    else values[flag] = value;
  }
  requireCheck([...flags].every((flag) => values[flag]), "Required: --blob --sha256 --size --origin --output and at least two --report paths.");
  requireCheck(reports.length >= 2 && reports.length <= 64 && new Set(reports).size === reports.length, "Supply 2 to 64 distinct report paths.");
  requireCheck(HEX.test(values["--sha256"]), "Expected SHA-256 must be 64 lowercase hexadecimal characters.");
  requireCheck(/^(0|[1-9][0-9]*)$/u.test(values["--size"]) && Number.isSafeInteger(Number(values["--size"])), "Expected size must be a non-negative safe integer.");
  return { blob: resolve(values["--blob"]), sha256: values["--sha256"], size: Number(values["--size"]),
    origin: exactOrigin(values["--origin"]), output: resolve(values["--output"]), reports };
}

async function readReport(path) {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    requireCheck(stat.isFile() && stat.size <= 65536, "Each report must be a regular file of at most 64 KiB.");
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    requireCheck(bytesRead <= 65536, "Report exceeds 64 KiB.");
    try { return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new EvidenceError("Report is not valid JSON."); }
  } finally { await handle.close(); }
}

// Deliberately independent of the browser digest implementation. No network,
// signer, decryption key or private order state is needed or accessed.
export async function verifyStorageAudits(options) {
  const nonces = new Set();
  const proofs = [];
  for (const path of options.reports) {
    const report = await readReport(path);
    requireCheck(report?.version === 1 && report.scope === SCOPE
      && Array.isArray(report.proofs) && report.proofs.length === 1
      && Array.isArray(report.failed) && report.failed.length === 0
      && Array.isArray(report.failures) && report.failures.length === 0,
    "Every supplied report must contain exactly one successful target and no failures; retain outage reports separately.");
    const proof = report.proofs[0];
    requireCheck(proof?.version === 1 && proof.scope === "full-read retrievability"
      && proof.origin === options.origin && proof.sha256 === options.sha256 && proof.size === options.size
      && HEX.test(proof.nonce) && HEX.test(proof.digest)
      && Number.isSafeInteger(proof.verifiedAt) && proof.verifiedAt > 0,
    "Proof does not match the expected target, file commitment or report format.");
    requireCheck(!nonces.has(proof.nonce), "Repeated challenge nonce: duplicated evidence cannot count as another audit.");
    nonces.add(proof.nonce);
    proofs.push(proof);
  }
  const sizeBytes = Buffer.alloc(8);
  sizeBytes.writeBigUInt64BE(BigInt(options.size));
  const digests = proofs.map((proof) => createHash("sha256")
    .update("wildbloom.storage-proof.v1\n").update(Buffer.from(proof.nonce, "hex")).update(sizeBytes));
  const fileHash = createHash("sha256");
  const handle = await open(options.blob, "r");
  let bytes = 0;
  try {
    const stat = await handle.stat();
    requireCheck(stat.isFile() && stat.size === options.size, "Ciphertext file size does not match the retained commitment.");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      requireCheck(bytes <= options.size, "Ciphertext changed size while reading.");
      fileHash.update(chunk);
      for (const digest of digests) digest.update(chunk);
    }
  } finally { await handle.close(); }
  requireCheck(bytes === options.size && fileHash.digest("hex") === options.sha256,
    "Ciphertext does not match the retained SHA-256 and size commitment.");
  requireCheck(digests.every((digest, i) => digest.digest("hex") === proofs[i].digest), "At least one challenge digest does not match the ciphertext.");
  return {
    version: 1,
    result: "saved-digests-verified",
    reportsVerified: proofs.length,
    distinctChallenges: nonces.size,
    scope: "Offline consistency of saved single-target reports with owner-pinned ciphertext.",
    limits: "Reports and their timestamps are unsigned. This does not establish signer identity, live requests, elapsed idle time, continuous retention, device actions or a passed soak test.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await verifyStorageAudits(options);
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`Verified ${result.reportsVerified} saved digests with distinct challenges. This is not a live soak-test pass.\n`);
  } catch (error) {
    // Never echo paths, report fields, URLs or raw OS errors into public logs.
    process.stderr.write(`${error instanceof EvidenceError ? error.message : "Could not read private evidence or create a new output file; check paths and permissions."}\n`);
    process.exitCode = 1;
  }
}
