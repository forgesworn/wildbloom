import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { auditStoredBlob, challengeDigest } from "../src/core/storage-proof.js";
import type { ResolvedHybridEvent } from "../src/core/types.js";
const secret = new Uint8Array(32).fill(42);
const buyer = {
  pubkey: getPublicKey(secret),
  signer: {
    getPublicKey: async () => getPublicKey(secret),
    signEvent: async (t: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent(t, secret),
  },
};
const content = Buffer.from("synthetic encrypted shard\0", "utf8");
const hash = createHash("sha256").update(content).digest("hex");
const file: ResolvedHybridEvent = {
  event: finalizeEvent(
    { kind: 1063, created_at: 1800000000, content: "", tags: [] },
    secret,
  ),
  url: `https://node.example/${hash}`,
  sha256: hash,
  size: content.length,
  name: "part.bin",
  mimeType: "application/octet-stream",
  trackers: [],
};
function independent(nonce: string): string {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(content.length));
  return createHash("sha256")
    .update("wildbloom.storage-proof.v1\n")
    .update(Buffer.from(nonce, "hex"))
    .update(size)
    .update(content)
    .digest("hex");
}
describe("private full-read storage audits", () => {
  it("matches an independent byte-level domain-separated vector", async () => {
    expect(await challengeDigest(new Blob([content]), "00".repeat(32))).toBe(
      independent("00".repeat(32)),
    );
    expect(
      await challengeDigest(new Blob([content]), "01".repeat(32)),
    ).not.toBe(independent("00".repeat(32)));
    await expect(challengeDigest(new Blob(), "invalid")).rejects.toThrow();
  });
  it("requires fresh nonces and independently verifies every retrieved byte", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/proof")) {
        const request = JSON.parse(String(init!.body));
        seen.push(request.nonce);
        return Response.json({
          version: 1,
          sha256: hash,
          nonce: request.nonce,
          size: content.length,
          digest: independent(request.nonce),
        });
      }
      expect(String(url)).toBe(file.url);
      return new Response(content, {
        headers: { "content-type": "application/octet-stream" },
      });
    };
    for (let i = 0; i < 2; i++) {
      const proof = await auditStoredBlob(file, "https://node.example", buyer, {
        fetchImpl,
      });
      expect(proof).toMatchObject({
        scope: "full-read retrievability",
        sha256: hash,
        size: content.length,
      });
      expect(proof.verifiedAt).toBeGreaterThan(0);
    }
    expect(seen[0]).not.toBe(seen[1]);
  });
  it.each(["stale", "mismatch", "corrupt"])(
    "refuses %s evidence",
    async (mode) => {
      let gets = 0;
      const fetchImpl: typeof fetch = async (url, init) => {
        if (String(url).endsWith("/proof")) {
          const request = JSON.parse(String(init!.body));
          return Response.json({
            version: 1,
            sha256: hash,
            nonce: mode === "stale" ? "00".repeat(32) : request.nonce,
            size: content.length,
            digest:
              mode === "mismatch"
                ? "ab".repeat(32)
                : independent(request.nonce),
          });
        }
        gets++;
        return new Response(
          mode === "corrupt" ? Buffer.alloc(content.length) : content,
        );
      };
      await expect(
        auditStoredBlob(file, "https://node.example", buyer, { fetchImpl }),
      ).rejects.toThrow();
      expect(gets).toBe(mode === "stale" ? 0 : 1);
    },
  );
});
