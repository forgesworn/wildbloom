import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decryptPrivacyEnvelope } from "../src/core/crypto.js";

interface SemanticCase {
  id: string;
  magic: string;
  category: "none" | "metadata" | "padding";
  recoveryKey: string;
  envelopeBase64: string;
}
const suite = JSON.parse(readFileSync(fileURLToPath(
  new URL("../test-vectors/encryption-semantic.json", import.meta.url),
), "utf8")) as { source: string; cases: SemanticCase[] };

describe("authenticated envelope semantics", () => {
  it.each(suite.cases)("validates $id after GCM authentication", async (entry) => {
    const bytes = Uint8Array.from(Buffer.from(entry.envelopeBase64, "base64"));
    const recovered = decryptPrivacyEnvelope(new Blob([bytes]), entry.recoveryKey);
    if (entry.category === "none") {
      const file = await recovered;
      expect(file.name).toBe("semantic.txt");
      expect(file.type).toBe("text/plain");
      expect(await file.text()).toBe(suite.source);
    } else {
      // Exact semantic errors prove the independent fixture authenticated;
      // generic rejects-to-throw would also pass for a broken AES fixture.
      await expect(recovered).rejects.toThrow(entry.category === "metadata"
        ? "The encrypted metadata is not canonical."
        : "The encrypted envelope padding is invalid.");
    }
  });

  it.each(suite.cases.filter((entry) => entry.category === "none"))(
    "rejects 258 records at the $magic header boundary", async (entry) => {
      const bytes = Uint8Array.from(Buffer.from(entry.envelopeBase64, "base64"));
      new DataView(bytes.buffer).setUint32(12, 258, false);
      await expect(decryptPrivacyEnvelope(new Blob([bytes]), entry.recoveryKey))
        .rejects.toThrow("The Wildbloom envelope header is invalid.");
    },
  );
});
