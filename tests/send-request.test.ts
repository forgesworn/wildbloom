// Shared vectors for wildbloom-request/1, copied unedited from the stage-1 node work:
//   source repository  forgesworn/wildbloom-node, branch feat/request-grants (PR #72)
//   source commit      c9e95db3d46fdc453f6f5993a8b945c5088b855a
//   source path        vectors/wildbloom-request-v1.json
//   copied to          test-vectors/wildbloom-request-v1.json (never edit it; copy it again)
// The Rust reference is check_invitation and read_reply in
// crates/wildbloomd/src/grants/tests/requests.rs. The SHA-256 below pins the copy.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encryptPrivacyEnvelope } from "../src/core/crypto.js";
import { parseRequestInvitation, RequestInvitationError } from "../src/send/request.js";
import { parseSendingReply, sendingReplyBytes } from "../src/send/reply.js";

const VECTOR_SHA256 = "a87c1b5885196205dde26cc6749e2541b0bd16ff957bb80ab8205f16c42aa323";
const raw = readFileSync(new URL("../test-vectors/wildbloom-request-v1.json", import.meta.url));

interface Vectors {
  now: number;
  invitation: {
    reasons: string[];
    valid: { name: string; invitation: string; pubkey: string; serverTag: string }[];
    invalid: { name: string; reason: string; invitation: string }[];
  };
  reply: {
    valid: { name: string; reply: string; sha256: string; size: number }[];
    invalid: { name: string; reply: string }[];
  };
}
const vectors = JSON.parse(raw.toString("utf8")) as Vectors;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function reasonFor(text: string): string | undefined {
  try {
    parseRequestInvitation(encode(text), vectors.now).dispose();
  } catch (error) {
    return error instanceof RequestInvitationError ? error.reason : `other: ${String(error)}`;
  }
  return undefined;
}

describe("the shared request vectors", () => {
  it("are the copy the stage-1 branch published", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(VECTOR_SHA256);
  });
});

describe("the invitation parser", () => {
  it.each(vectors.invitation.valid.map((entry) => [entry.name, entry] as const))("accepts %s", (_name, entry) => {
    const parsed = parseRequestInvitation(encode(entry.invitation), vectors.now);
    expect(parsed.pubkey).toBe(entry.pubkey);
    expect(parsed.serverTag).toBe(entry.serverTag);
    expect(parsed.node.endsWith("/")).toBe(true);
    expect(parsed.origin).toBe(parsed.node.slice(0, -1));
    expect(parsed.files).toBe(1);
    expect(parsed.signer).toHaveLength(32);
    parsed.dispose();
  });

  it.each(vectors.invitation.invalid.map((entry) => [entry.name, entry] as const))("refuses %s", (_name, entry) => {
    expect(reasonFor(entry.invitation)).toBe(entry.reason);
  });

  it("names every documented rule at least once, and no other", () => {
    const named = new Set(vectors.invitation.invalid.map((entry) => entry.reason));
    expect([...named].sort()).toEqual([...vectors.invitation.reasons].sort());
  });

  it("measures the length rule in bytes, not characters", () => {
    expect(reasonFor("é".repeat(8_200))).toBe("length");
    expect(reasonFor("")).toBe("length");
  });

  it("refuses bytes that are not UTF-8", () => {
    const bytes = encode(vectors.invitation.valid[0]!.invitation);
    bytes[10] = 0xff;
    expect(() => parseRequestInvitation(bytes, vectors.now)).toThrowError(expect.objectContaining({ reason: "shape" }));
  });

  it("refuses a lone surrogate escaped in a string, as the reference parser cannot hold one", () => {
    const text = vectors.invitation.valid[0]!.invitation.replace("storage.example", "storage.example\\ud800");
    expect(reasonFor(text)).toBe("shape");
  });

  it("refuses numbers written with a fraction or exponent even when they are whole", () => {
    const base = vectors.invitation.valid[0]!.invitation;
    expect(reasonFor(base.replace('"files":1', '"files":1.0'))).toBe("shape");
    expect(reasonFor(base.replace('"files":1', '"files":1e0'))).toBe("shape");
    expect(reasonFor(base.replace('"files":1', '"files":01'))).toBe("shape");
    expect(reasonFor(base.replace('"files":1', '"files":18446744073709551616'))).toBe("shape");
  });

  it("zeroes the secret key bytes on dispose and when a rule refuses", () => {
    const parsed = parseRequestInvitation(encode(vectors.invitation.valid[0]!.invitation), vectors.now);
    expect([...parsed.signer].some((byte) => byte !== 0)).toBe(true);
    parsed.dispose();
    expect([...parsed.signer].every((byte) => byte === 0)).toBe(true);
  });

  it("works with a file key that the encryptor then accepts", async () => {
    const parsed = parseRequestInvitation(encode(vectors.invitation.valid[0]!.invitation), vectors.now);
    const sealed = await encryptPrivacyEnvelope(new File(["hello"], "hello.txt", { type: "text/plain" }), { key: parsed.key });
    expect(sealed.recoveryKey).toBe(parsed.key);
    parsed.dispose();
  });
});

describe("the reply", () => {
  it.each(vectors.reply.valid.map((entry) => [entry.name, entry] as const))("reads %s", (_name, entry) => {
    expect(parseSendingReply(encode(entry.reply))).toEqual({ sha256: entry.sha256, size: entry.size });
  });

  it.each(vectors.reply.invalid.map((entry) => [entry.name, entry] as const))("refuses %s", (_name, entry) => {
    expect(parseSendingReply(encode(entry.reply))).toBeUndefined();
  });

  it("writes the canonical reply byte for byte", () => {
    const canonical = vectors.reply.valid[0]!;
    expect(new TextDecoder().decode(sendingReplyBytes(canonical.sha256, canonical.size))).toBe(canonical.reply);
  });

  it("will not write a reply that its own reader would refuse", () => {
    expect(() => sendingReplyBytes("AB".repeat(32), 1)).toThrow();
    expect(() => sendingReplyBytes("ab".repeat(32), 0)).toThrow();
    expect(() => sendingReplyBytes("ab".repeat(32), 1.5)).toThrow();
    expect(() => sendingReplyBytes("ab".repeat(31), 1)).toThrow();
  });
});
