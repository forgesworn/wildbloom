import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decryptPrivacyEnvelope } from "../src/core/crypto.js";

interface NegativeCase {
  id: string;
  category: string;
  description: string;
  recoveryKey: string;
  envelopeBase64: string;
}

const suite = JSON.parse(
  readFileSync(fileURLToPath(new URL("../test-vectors/encryption-negative.json", import.meta.url)), "utf8"),
) as { cases: NegativeCase[] };

function envelopeOf(entry: NegativeCase): Blob {
  return new Blob([Uint8Array.from(Buffer.from(entry.envelopeBase64, "base64"))]);
}

describe("encryption negative vectors", () => {
  const control = suite.cases.filter((entry) => entry.category === "none");
  const tampered = suite.cases.filter((entry) => entry.category !== "none");

  it("has a control and a broad tamper set", () => {
    expect(control.length).toBe(1);
    expect(tampered.length).toBeGreaterThanOrEqual(10);
  });

  it.each(control)("accepts the control vector: $id", async (entry) => {
    const recovered = await decryptPrivacyEnvelope(envelopeOf(entry), entry.recoveryKey);
    expect(recovered.size).toBeGreaterThan(0);
  });

  it.each(tampered)("rejects $id ($category): $description", async (entry) => {
    await expect(decryptPrivacyEnvelope(envelopeOf(entry), entry.recoveryKey)).rejects.toThrow();
  });
});
