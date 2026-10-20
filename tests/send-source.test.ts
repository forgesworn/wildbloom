import { describe, expect, it } from "vitest";
import { DISGUISING_CHARACTERS, decodeMessage } from "../src/direct/messages.js";
import { plainName, prepareSource } from "../src/send/source.js";

// Every character the rule names: the Arabic letter mark, the Mongolian vowel separator, the zero-width and
// directional marks, the embeddings and overrides, the word joiner and invisible operators, the isolates and
// the byte order mark.
const DISGUISING: readonly number[] = [
  0x061c, 0x180e,
  ...Array.from({ length: 5 }, (_, index) => 0x200b + index),
  ...Array.from({ length: 5 }, (_, index) => 0x202a + index),
  ...Array.from({ length: 5 }, (_, index) => 0x2060 + index),
  ...Array.from({ length: 4 }, (_, index) => 0x2066 + index),
  0xfeff,
];
const manifestWithName = (name: string): Uint8Array => new TextEncoder().encode(JSON.stringify({ event: "manifest", name, size: 5, type: "application/pdf", v: 1 }));
const context = { from: "page", index: 0, iceAllowlist: [], max: 250_000_000 } as const;

describe("names that disguise their extension", () => {
  it("covers exactly the characters the rule names", () => {
    expect(DISGUISING).toHaveLength(2 + 5 + 5 + 5 + 4 + 1);
    for (const code of DISGUISING) expect("a".concat(String.fromCodePoint(code), "b").replace(DISGUISING_CHARACTERS, "")).toBe("ab");
    // The characters either side of each range are not part of it.
    for (const code of [0x061b, 0x061d, 0x180d, 0x180f, 0x2009, 0x200a, 0x2010, 0x202f, 0x205f, 0x2065, 0x2070, 0xfefe, 0xff00]) {
      const name = `a${String.fromCodePoint(code)}b`;
      expect(name.replace(DISGUISING_CHARACTERS, "")).toBe(name);
    }
  });

  it.each(DISGUISING.map((code) => [`U+${code.toString(16).toUpperCase().padStart(4, "0")}`, code] as const))("is refused in a manifest, as failed: %s", (_label, code) => {
    for (const name of [`invoice${String.fromCodePoint(code)}fdp.terminal`, `${String.fromCodePoint(code)}report.pdf`, `report.pdf${String.fromCodePoint(code)}`]) {
      const result = decodeMessage(manifestWithName(name), context);
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.stop).toBe("failed");
    }
  });

  it("is refused whichever way the manifest spells it, and an honest name still passes", () => {
    // The override, written as an escape rather than the character, is refused too (the canonical form is the character).
    expect(decodeMessage(new TextEncoder().encode('{"event":"manifest","name":"invoice\\u202efdp.terminal","size":5,"type":"application/pdf","v":1}'), context)).toMatchObject({ ok: false, stop: "failed" });
    expect(decodeMessage(manifestWithName("invoice.pdf"), context)).toMatchObject({ ok: true });
    expect(decodeMessage(manifestWithName("Café holiday – 2026.pdf"), context)).toMatchObject({ ok: true });
    // Characters next to the ranges are ordinary.
    expect(decodeMessage(manifestWithName("a⁥b.pdf"), context)).toMatchObject({ ok: true });
  });

  it("is removed from the name the phone sends, so an honest file still goes", () => {
    expect(plainName("invoice‮fdp.terminal")).toBe("invoicefdp.terminal");
    for (const code of DISGUISING) expect(plainName(`a${String.fromCodePoint(code)}b.txt`)).toBe("ab.txt");
    const prepared = prepareSource(new File(["x"], "invoice‮fdp.terminal", { type: "application/pdf" }));
    expect(prepared.name).toBe("invoicefdp.terminal");
    // What the phone makes of it is what the receiver accepts.
    expect(decodeMessage(manifestWithName(prepared.name), context)).toMatchObject({ ok: true });
  });

  it("leaves a name with none of them as it was, and a name made only of them as the fallback", () => {
    expect(prepareSource(new File(["x"], "plain name.txt")).name).toBe("plain name.txt");
    expect(prepareSource(new File(["x"], "‮​﻿")).name).toBe("blob.bin");
    expect(prepareSource(new File(["x"], `${"‮".repeat(300)}ok.txt`)).name).toBe("ok.txt");
  });

  it("removes them before the leading dots and spaces are, so a hidden dot cannot survive", () => {
    expect(prepareSource(new File(["x"], "​.​.hidden")).name).toBe("hidden");
    expect(prepareSource(new File(["x"], " ⁠ name.txt")).name).toBe("name.txt");
  });
});
