import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decryptPrivacyEnvelope, encryptPrivacyEnvelope } from "../src/core/crypto.js";
import { sanitiseFileName } from "../src/core/security.js";

const suite = JSON.parse(readFileSync(new URL("../test-vectors/unicode-filenames.json", import.meta.url), "utf8")) as {
  keyHex: string;
  source: string;
  cases: { id: string; inputName: string; expectedName: string; envelopeBase64: string }[];
};

it.each(suite.cases)("shares canonical Unicode filenames with Stash: $id", async (entry) => {
  expect(sanitiseFileName(entry.inputName)).toBe(entry.expectedName);
  const bytes = Uint8Array.from(Buffer.from(entry.envelopeBase64, "base64"));
  const key = `wbk1_${Buffer.from(suite.keyHex, "hex").toString("base64url")}`;
  const opened = await decryptPrivacyEnvelope(new Blob([bytes]), key);
  expect(opened.name).toBe(entry.expectedName);
  expect(await opened.text()).toBe(suite.source);
  const encrypted = await encryptPrivacyEnvelope(new File([suite.source], entry.inputName, { type: "text/plain" }));
  const restored = await decryptPrivacyEnvelope(encrypted.file, encrypted.recoveryKey);
  expect(restored.name).toBe(entry.expectedName);
  expect(await restored.text()).toBe(suite.source);
});
