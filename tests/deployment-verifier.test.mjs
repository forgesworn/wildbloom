import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import {
  CONTENT_SECURITY_POLICY,
  DENIED_PERMISSION_FEATURES,
  META_CONTENT_SECURITY_POLICY,
  PERMISSIONS_POLICY,
  SECURITY_HEADERS,
} from "../scripts/http-security.mjs";
import {
  assertHsts,
  assertSecurityHeaders,
  normaliseDeploymentOrigin,
  validateReleaseEvidence,
  verifyDeployment,
} from "../scripts/verify-deployment.mjs";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function base32(bytes) {
  let result = "";
  let bits = 0;
  let accumulator = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32[(accumulator >>> bits) & 31];
    }
  }
  return result;
}

function onionHostname() {
  const publicKey = new Uint8Array(32).fill(29);
  const version = new Uint8Array([3]);
  const prefix = new TextEncoder().encode(".onion checksum");
  const checksumInput = new Uint8Array(prefix.length + publicKey.length + 1);
  checksumInput.set(prefix);
  checksumInput.set(publicKey, prefix.length);
  checksumInput.set(version, prefix.length + publicKey.length);
  const address = new Uint8Array(35);
  address.set(publicKey);
  address.set(sha3_256(checksumInput).subarray(0, 2), 32);
  address.set(version, 34);
  return `${base32(address)}.onion`;
}

function releaseEvidence() {
  const files = [
    { path: "assets/app-abcdefgh.js", bytes: 3, sha256: sha256("app") },
    { path: "index.html", bytes: 5, sha256: sha256("index") },
  ];
  return {
    format: "wildbloom-release-evidence-v2",
    sourceCommit: "ab".repeat(20),
    sourceTreeClean: true,
    packageLockSha256: "cd".repeat(32),
    buildToolchain: { node: "v24.19.0", npm: "11.17.0" },
    buildSha256: sha256(files.map((file) => `${file.sha256}  ${file.bytes}  ${file.path}\n`).join("")),
    files,
  };
}

describe("deployment origin validation", () => {
  it("accepts HTTPS and checksum-valid HTTP v3 onion origins", () => {
    const onion = onionHostname();
    expect(normaliseDeploymentOrigin("https://wildbloom.example/")).toBe("https://wildbloom.example");
    expect(normaliseDeploymentOrigin(`http://${onion}`)).toBe(`http://${onion}`);
  });

  it("rejects insecure, ambiguous and corrupted origins", () => {
    const onion = onionHostname();
    const corrupted = `${onion[0] === "a" ? "b" : "a"}${onion.slice(1)}`;
    expect(() => normaliseDeploymentOrigin("http://wildbloom.example")).toThrow(/requires HTTPS/u);
    expect(() => normaliseDeploymentOrigin("https://user:pass@wildbloom.example")).toThrow(/credentials/u);
    expect(() => normaliseDeploymentOrigin("https://wildbloom.example/app")).toThrow(/path/u);
    expect(() => normaliseDeploymentOrigin(`http://${corrupted}`)).toThrow(/checksum/u);
    expect(() => normaliseDeploymentOrigin(`https://${onion}`)).toThrow(/HTTP onion/u);
  });
});

describe("release evidence validation", () => {
  it("returns an immutable copy of exact, bounded evidence", () => {
    const evidence = releaseEvidence();
    const validated = validateReleaseEvidence(evidence);
    evidence.files[0].sha256 = "00".repeat(32);
    expect(validated.files[0].sha256).toBe(sha256("app"));
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.files)).toBe(true);
    expect(Object.isFrozen(validated.files[0])).toBe(true);
    expect(Object.isFrozen(validated.buildToolchain)).toBe(true);
  });

  it("rejects dirty, non-canonical, unsafe and inconsistent evidence", () => {
    expect(() => validateReleaseEvidence({ ...releaseEvidence(), sourceTreeClean: false })).toThrow(/clean source tree/u);
    expect(() => validateReleaseEvidence({ ...releaseEvidence(), files: [...releaseEvidence().files].reverse() })).toThrow(/canonical/u);
    expect(() => validateReleaseEvidence({
      ...releaseEvidence(),
      files: releaseEvidence().files.map((file) => ({ ...file, bytes: 33 * 1024 * 1024 })),
    })).toThrow(/excessive byte count/u);
    const inconsistent = releaseEvidence();
    inconsistent.files[0].sha256 = "00".repeat(32);
    expect(() => validateReleaseEvidence(inconsistent)).toThrow(/aggregate build hash/u);
    expect(() => validateReleaseEvidence({
      ...releaseEvidence(),
      buildToolchain: { node: "v25.0.0", npm: "11.17.0" },
    })).toThrow(/Node build version/u);
  });

  it("rejects invalid evidence before an imported caller can trigger a request", async () => {
    await expect(verifyDeployment(
      "http://127.0.0.1:1",
      { ...releaseEvidence(), sourceTreeClean: false },
      { allowLoopback: true },
    )).rejects.toThrow(/clean source tree/u);
  });
});

describe("deployed security-header validation", () => {
  it("fails closed for unused resource types, DOM injection sinks and browser capabilities", () => {
    for (const directive of [
      "default-src 'none'",
      "font-src 'none'",
      "frame-src 'none'",
      "manifest-src 'none'",
      "media-src 'none'",
      "trusted-types 'none'",
      "require-trusted-types-for 'script'",
    ]) {
      expect(CONTENT_SECURITY_POLICY).toContain(directive);
    }
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/'unsafe-(?:eval|inline)'/u);
    expect(DENIED_PERMISSION_FEATURES).toEqual([...DENIED_PERMISSION_FEATURES].sort());
    expect(new Set(DENIED_PERMISSION_FEATURES).size).toBe(DENIED_PERMISSION_FEATURES.length);
    for (const feature of [
      "attribution-reporting",
      "camera",
      "clipboard-read",
      "digital-credentials-get",
      "display-capture",
      "geolocation",
      "identity-credentials-get",
      "local-fonts",
      "microphone",
      "payment",
      "storage-access",
      "tools",
      "usb",
    ]) {
      expect(DENIED_PERMISSION_FEATURES).toContain(feature);
      expect(PERMISSIONS_POLICY).toContain(`${feature}=()`);
    }
  });

  it("keeps the static-document CSP aligned with the response policy", () => {
    const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const metaPolicy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(source)?.[1];
    expect(metaPolicy).toBe(META_CONTENT_SECURITY_POLICY);
  });

  it("requires the exact production policy and at least one year of HSTS", () => {
    const headers = new Headers(SECURITY_HEADERS);
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    expect(() => assertSecurityHeaders(headers, "test response")).not.toThrow();
    expect(() => assertHsts(headers)).not.toThrow();

    headers.set("Content-Security-Policy", `${SECURITY_HEADERS["Content-Security-Policy"]}; script-src https:`);
    expect(() => assertSecurityHeaders(headers, "test response")).toThrow(/Content-Security-Policy/u);
    headers.set("Content-Security-Policy", SECURITY_HEADERS["Content-Security-Policy"]);
    headers.set("Strict-Transport-Security", "max-age=300");
    expect(() => assertHsts(headers)).toThrow(/one year/u);
  });
});
