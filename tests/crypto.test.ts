import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/crypto.js";

describe("sha256Hex", () => {
  it("matches the standard abc vector", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
