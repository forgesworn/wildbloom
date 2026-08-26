import { describe, expect, it } from "vitest";
import { decryptPrivacyEnvelope, encryptPrivacyEnvelope, sha256Hex } from "../src/core/crypto.js";

describe("sha256Hex", () => {
  it("matches the standard abc vector", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes streamed Blob input without changing the vector", async () => {
    expect(await sha256Hex(new Blob(["a", "b", "c"]))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("Wildbloom privacy envelopes", () => {
  it("round-trips content and keeps source metadata out of public bytes", async () => {
    const source = new File(["quietly private"], "private-plan.txt", { type: "text/plain" });
    const protectedFile = await encryptPrivacyEnvelope(source);
    const publicBytes = new Uint8Array(await protectedFile.file.arrayBuffer());
    const publicText = new TextDecoder().decode(publicBytes);
    expect(protectedFile.file.name).toBe("wildbloom.wbenc");
    expect(protectedFile.file.type).toBe("application/vnd.wildbloom.encrypted");
    expect(protectedFile.recoveryKey).toMatch(/^wbk1_[A-Za-z0-9_-]{43}$/u);
    expect(publicText).not.toContain("private-plan.txt");
    expect(publicText).not.toContain("quietly private");

    const decrypted = await decryptPrivacyEnvelope(protectedFile.file, protectedFile.recoveryKey);
    expect(decrypted.name).toBe(source.name);
    expect(decrypted.type).toBe(source.type);
    expect(await decrypted.text()).toBe("quietly private");
  });

  it("uses fresh keys and nonces for the same source", async () => {
    const source = new File(["same input"], "same.txt", { type: "text/plain" });
    const first = await encryptPrivacyEnvelope(source);
    const second = await encryptPrivacyEnvelope(source);
    expect(first.recoveryKey).not.toBe(second.recoveryKey);
    expect(await sha256Hex(first.file)).not.toBe(await sha256Hex(second.file));
  });

  it("pads small sources to the same public size bucket", async () => {
    const small = await encryptPrivacyEnvelope(new File(["a"], "a.txt"));
    const larger = await encryptPrivacyEnvelope(new File([new Uint8Array(8_000)], "b.bin"));
    expect(small.file.size).toBe(larger.file.size);
  });

  it("rejects a wrong key and authenticated-byte tampering", async () => {
    const first = await encryptPrivacyEnvelope(new File(["secret"], "secret.txt"));
    const second = await encryptPrivacyEnvelope(new File(["other"], "other.txt"));
    await expect(decryptPrivacyEnvelope(first.file, second.recoveryKey)).rejects.toThrow(/wrong|modified/u);

    const tampered = new Uint8Array(await first.file.arrayBuffer());
    tampered[40] = (tampered[40] ?? 0) ^ 1;
    await expect(decryptPrivacyEnvelope(new Blob([tampered]), first.recoveryKey)).rejects.toThrow(/modified/u);
  });

  it("rejects malformed recovery material without probing the envelope", async () => {
    const protectedFile = await encryptPrivacyEnvelope(new File(["secret"], "secret.txt"));
    await expect(decryptPrivacyEnvelope(protectedFile.file, "not-a-key")).rejects.toThrow(/v1 key/u);
  });
});
